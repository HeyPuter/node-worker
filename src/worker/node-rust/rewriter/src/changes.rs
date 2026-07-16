use std::cmp::Ordering;

use oxc::{
    allocator::{Allocator, StringBuilder, Vec},
    span::Span,
};
use transform::{
    LayoutPiece, Transformer,
    transform::{Transform, TransformElement, TransformElements, TransformLL},
};

use crate::visitor::{NamedMap, NamedMapImported, SystemJsModule};

/// terse constructor for a [`JsChange`]: `change!(span, Delete)`, `change!(span, CloseParen { count })`
macro_rules! change {
    ($span:expr, $($ty:tt)*) => {
        $crate::changes::JsChange::new($span, $crate::changes::JsChangeType::$($ty)*)
    };
}
pub(crate) use change;

/// A single edit over the *original* source, in original-source coordinates. The [`Transformer`]
/// remaps `span` into laid-out coordinates before applying it, so all spans here are original.
///
/// Wrapping an expression (`_export("x", <expr>)`) is always encoded as a left change plus a shared
/// [`JsChangeType::CloseParen`] right change — a single low-level change can only emit on one side of
/// a span, and a whole-region replace would forbid the nested rewrites the interior may still need.
pub struct JsChange<'alloc: 'data, 'data> {
    pub span: Span,
    pub ty: JsChangeType<'alloc, 'data>,
}

impl<'alloc: 'data, 'data> JsChange<'alloc, 'data> {
    pub fn new(span: Span, ty: JsChangeType<'alloc, 'data>) -> Self {
        Self { span, ty }
    }
}

pub enum JsChangeType<'alloc: 'data, 'data> {
    /// replace the span with `""` (remove `import …;`, `export {…} from`, `export *`, or an
    /// `export`/`export default `/`export <kind> ` keyword prefix)
    Delete,

    /// `import.meta` -> `{ident}_context.meta`
    ContextMeta,
    /// dynamic `import` keyword -> `{ident}_context.import`
    ContextImport,
    /// free `__moduleName` -> `{ident}_context.id`
    ContextId,

    /// replace an `export <kind> `/`export default ` prefix with `{ident}_export("name", `.
    /// pairs with a [`JsChangeType::CloseParen`] `{ count: 1 }`
    ExportInitLeft { name: NamedMapImported<'data> },
    /// insert `count` × `)`
    CloseParen { count: u32 },

    /// insert `[{ident}_export("A", [{ident}_export("B", ]]local=` before a hoisted class expression:
    /// binds the class to its hoisted `var local` (so moved functions can reference it) and exports it
    /// under each name. `names` empty for a plain top-level class. pairs with a
    /// [`JsChangeType::CloseParen`] `{ count: names.len() }`
    HoistAssignLeft { names: Vec<'alloc, NamedMapImported<'data>>, local: &'data str },

    /// replace a whole `export { a, b as c };` (no source) with one `{ident}_export("ext", local);`
    /// per specifier
    ExportGroup { names: Vec<'alloc, NamedMap<'data>> },

    /// insert `(` — opens a destructuring export/assignment `(pattern = init, …)`
    OpenParen,
    /// close a destructuring export/assignment: insert `, {ident}_export("ext", local), …)`
    /// (one call per bound target; `external`/`local` differ for `[x] = a` exported as `y`)
    PatternExports { names: Vec<'alloc, NamedMap<'data>> },

    /// insert `{ident}_export("a", {ident}_export("b", ` before an assignment to an exported local,
    /// nesting outermost-first. pairs with a [`JsChangeType::CloseParen`] `{ count: names.len() }`
    ExportAssignLeft { names: Vec<'alloc, NamedMapImported<'data>> },

    /// re-export an exported local mutated by `++`/`--`, preserving value semantics:
    /// prefix  `++x` -> `{ident}_export("a", ++x)` (value = new)
    /// postfix `x++` -> `(x++, {ident}_export("a", x), x - 1)` (value = old, export = new)
    ExportUpdate {
        names: Vec<'alloc, NamedMapImported<'data>>,
        local: &'data str,
        increment: bool,
        prefix: bool,
    },
}

impl JsChangeType<'_, '_> {
    /// tie-break rank for changes that share a `span.start`: closers must come after everything else
    fn rank(&self) -> u8 {
        match self {
            JsChangeType::CloseParen { .. } => 1,
            _ => 0,
        }
    }
}

impl PartialEq for JsChange<'_, '_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for JsChange<'_, '_> {}
impl PartialOrd for JsChange<'_, '_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for JsChange<'_, '_> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.span
            .start
            .cmp(&other.span.start)
            .then_with(|| self.ty.rank().cmp(&other.ty.rank()))
    }
}

/// push `{ident}_export(<name-literal>, ` — the opener of an `_export` call.
/// `Ident` names are wrapped in quotes; `Literal` names carry the raw (already-quoted) source literal.
fn push_export_open<'data>(c: &mut TransformElements<'data>, ident: &'data str, name: &NamedMapImported<'data>) {
    c.push(TransformElement::Str(ident));
    if name.is_ident() {
        c.push(TransformElement::Str("_export(\""));
        c.push(TransformElement::Str(name.name()));
        c.push(TransformElement::Str("\", "));
    } else {
        c.push(TransformElement::Str("_export("));
        c.push(TransformElement::Str(name.name()));
        c.push(TransformElement::Str(", "));
    }
}

impl<'alloc: 'data, 'data> Transform<'data> for JsChange<'alloc, 'data> {
    type ToLowLevelData = &'data str;

    fn span(&self) -> Span {
        self.span
    }

    fn set_span(&mut self, span: Span) {
        self.span = span;
    }

    fn into_low_level(self, ident: &Self::ToLowLevelData, _offset: i32) -> TransformLL<'data> {
        let ident = *ident;
        let mut c = TransformElements::new();
        match self.ty {
            JsChangeType::Delete => TransformLL::replace(c),

            JsChangeType::ContextMeta => {
                c.push(TransformElement::Str(ident));
                c.push(TransformElement::Str("_context.meta"));
                TransformLL::replace(c)
            }
            JsChangeType::ContextImport => {
                c.push(TransformElement::Str(ident));
                c.push(TransformElement::Str("_context.import"));
                TransformLL::replace(c)
            }
            JsChangeType::ContextId => {
                c.push(TransformElement::Str(ident));
                c.push(TransformElement::Str("_context.id"));
                TransformLL::replace(c)
            }

            JsChangeType::ExportInitLeft { name } => {
                push_export_open(&mut c, ident, &name);
                TransformLL::replace(c)
            }

            JsChangeType::CloseParen { count } => {
                for _ in 0..count {
                    c.push(TransformElement::Str(")"));
                }
                TransformLL::insert(c)
            }

            JsChangeType::HoistAssignLeft { names, local } => {
                for name in &names {
                    push_export_open(&mut c, ident, name);
                }
                c.push(TransformElement::Str(local));
                c.push(TransformElement::Str("="));
                TransformLL::insert(c)
            }

            JsChangeType::ExportGroup { names } => {
                for map in &names {
                    push_export_open(&mut c, ident, &map.external);
                    c.push(TransformElement::Str(map.local.name()));
                    c.push(TransformElement::Str(");"));
                }
                TransformLL::replace(c)
            }

            JsChangeType::ExportAssignLeft { names } => {
                for name in &names {
                    push_export_open(&mut c, ident, name);
                }
                TransformLL::insert(c)
            }

            JsChangeType::OpenParen => {
                c.push(TransformElement::Str("("));
                TransformLL::insert(c)
            }

            JsChangeType::PatternExports { names } => {
                for map in &names {
                    c.push(TransformElement::Str(", "));
                    push_export_open(&mut c, ident, &map.external);
                    c.push(TransformElement::Str(map.local.name()));
                    c.push(TransformElement::Str(")"));
                }
                c.push(TransformElement::Str(")"));
                TransformLL::insert(c)
            }

            JsChangeType::ExportUpdate { names, local, increment, prefix } => {
                let op = if increment { "++" } else { "--" };
                if prefix {
                    // `{ident}_export("a", ++x)` — value and export are both the new value
                    for name in &names {
                        push_export_open(&mut c, ident, name);
                    }
                    c.push(TransformElement::Str(op));
                    c.push(TransformElement::Str(local));
                    for _ in 0..names.len() {
                        c.push(TransformElement::Str(")"));
                    }
                } else {
                    // `({ident}$u => ({ident}_export("a", x), {ident}$u))(x++)`
                    // the arg `x++` yields the spec-correct old value (works for number/string/BigInt);
                    // the body exports the new value and returns the captured old value
                    c.push(TransformElement::Str("("));
                    c.push(TransformElement::Str(ident));
                    c.push(TransformElement::Str("$u => ("));
                    for name in &names {
                        push_export_open(&mut c, ident, name);
                        c.push(TransformElement::Str(local));
                        c.push(TransformElement::Str("), "));
                    }
                    c.push(TransformElement::Str(ident));
                    c.push(TransformElement::Str("$u))("));
                    c.push(TransformElement::Str(local));
                    c.push(TransformElement::Str(op));
                    c.push(TransformElement::Str(")"));
                }
                TransformLL::replace(c)
            }
        }
    }
}

pub struct JsChanges<'alloc: 'data, 'data> {
    inner: Transformer<'alloc, 'data, JsChange<'alloc, 'data>>,
    ident: &'data str,
}

impl<'alloc, 'data> JsChanges<'alloc, 'data> {
    pub fn new(ident: &'data str) -> Self {
        Self {
            inner: Transformer::new(),
            ident,
        }
    }

    pub fn add(&mut self, change: JsChange<'alloc, 'data>) {
        self.inner.add([change]);
    }

    pub fn perform(
        &mut self,
        alloc: &'alloc Allocator,
        js: &'data str,
        module: &SystemJsModule<'alloc, 'data>,
    ) -> Result<Vec<'alloc, u8>, transform::TransformError> {
        self.inner.set_alloc(alloc)?;
        let layout = build_layout(alloc, self.ident, module);
        let result = self.inner.perform(js, &layout, &self.ident)?;
        self.inner.take_alloc()?;
        Ok(result)
    }
}

/// Synthesize the `<ident>.register(...)` wrapper as layout pieces around the (unmoved) body.
/// `<ident>` is a free identifier the caller binds to the SystemJS instance — see esm.ts, which
/// wraps the output in `new Function(ident, code)` and calls it with `System`.
///
/// ```text
/// <ident>.register([<sources>], function (I_export, I_context) {
///   "use strict"; var <hoists>;
///   <Move each hoisted fn> I_export("f", f);
///   return { setters: [ <one per dep> ], execute: <async?> function () {
///     <Remainder: original body, edited by JsChanges>
///   } };
/// })
/// ```
#[allow(clippy::too_many_lines)]
fn build_layout<'alloc, 'data>(
    alloc: &'alloc Allocator,
    ident: &'data str,
    module: &SystemJsModule<'alloc, 'data>,
) -> std::vec::Vec<LayoutPiece<'alloc>> {
    let mut itoa = itoa::Buffer::new();

    // deps in registration (index) order
    let mut deps: std::vec::Vec<_> = module.deps.values().collect();
    deps.sort_by_key(|d| d.idx);

    // ---- header part 1: register open, params, "use strict", var hoists ----
    let mut pre = StringBuilder::new_in(alloc);
    pre.push_str(ident);
    pre.push_str(".register([");
    for (i, dep) in deps.iter().enumerate() {
        if i != 0 {
            pre.push(',');
        }
        pre.push_str(dep.raw);
    }
    pre.push_str("], function(");
    pre.push_str(ident);
    pre.push_str("_export, ");
    pre.push_str(ident);
    pre.push_str("_context) {\"use strict\";");
    if !module.hoisted_idents.is_empty() {
        pre.push_str("var ");
        for (i, id) in module.hoisted_idents.iter().enumerate() {
            if i != 0 {
                pre.push(',');
            }
            pre.push_str(id);
        }
        pre.push(';');
    }

    let mut layout = std::vec::Vec::new();
    layout.push(LayoutPiece::Template(pre.into_str()));

    // ---- hoisted function declarations: Move each out of `execute` into this (declare) scope;
    // exported ones are also `_export`ed here so they are live before the module executes ----
    for f in &module.hoisted_fns {
        layout.push(LayoutPiece::Move(f.span));
        if let Some(exported) = &f.exported {
            let mut e = StringBuilder::new_in(alloc);
            push_export_name_sb(&mut e, ident, exported);
            e.push_str(f.local);
            e.push_str(");");
            layout.push(LayoutPiece::Template(e.into_str()));
        }
    }

    // ---- header part 2: setters array + execute open ----
    let mut mid = StringBuilder::new_in(alloc);
    mid.push_str("return{setters:[");
    for (i, dep) in deps.iter().enumerate() {
        if i != 0 {
            mid.push(',');
        }
        let param = {
            let mut p = StringBuilder::new_in(alloc);
            p.push_str(ident);
            p.push('$');
            p.push_str(itoa.format(dep.idx));
            p.into_str()
        };
        mid.push_str("function(");
        mid.push_str(param);
        mid.push_str("){");

        for local in &dep.default_imports {
            mid.push_str(local);
            mid.push('=');
            mid.push_str(param);
            mid.push_str(".default;");
        }
        for map in &dep.named_imports {
            // local = param.external
            mid.push_str(map.local.name());
            mid.push('=');
            push_member(&mut mid, param, &map.external);
            mid.push(';');
        }
        for local in &dep.star_imports {
            mid.push_str(local);
            mid.push('=');
            mid.push_str(param);
            mid.push(';');
        }
        for map in &dep.reexports {
            // _export("external", param.local)
            push_export_name_sb(&mut mid, ident, &map.external);
            push_member(&mut mid, param, &map.local);
            mid.push_str(");");
        }
        for name in &dep.star_ns_reexports {
            // _export("external", param)  — the whole namespace
            push_export_name_sb(&mut mid, ident, name);
            mid.push_str(param);
            mid.push_str(");");
        }
        if dep.star_reexport {
            // var _e={};for(var _k in param){if(_k!=="default"&&_k!=="__esModule")_e[_k]=param[_k];}_export(_e);
            let e = {
                let mut s = StringBuilder::new_in(alloc);
                s.push_str(ident);
                s.push_str("$e");
                s.into_str()
            };
            let k = {
                let mut s = StringBuilder::new_in(alloc);
                s.push_str(ident);
                s.push_str("$k");
                s.into_str()
            };
            mid.push_str("var ");
            mid.push_str(e);
            mid.push_str("={};for(var ");
            mid.push_str(k);
            mid.push_str(" in ");
            mid.push_str(param);
            mid.push_str("){if(");
            mid.push_str(k);
            mid.push_str("!==\"default\"&&");
            mid.push_str(k);
            mid.push_str("!==\"__esModule\")");
            mid.push_str(e);
            mid.push('[');
            mid.push_str(k);
            mid.push_str("]=");
            mid.push_str(param);
            mid.push('[');
            mid.push_str(k);
            mid.push_str("];}");
            mid.push_str(ident);
            mid.push_str("_export(");
            mid.push_str(e);
            mid.push_str(");");
        }

        mid.push('}');
    }
    mid.push_str("],execute:");
    if module.has_tla {
        mid.push_str("async ");
    }
    mid.push_str("function(){");
    layout.push(LayoutPiece::Template(mid.into_str()));

    // ---- body ----
    layout.push(LayoutPiece::Remainder);

    // ---- footer: close execute fn, return object, register callback, register call ----
    // The leading newline is load-bearing: the body is emitted verbatim, and if the
    // source's last line is a `//` line comment with no trailing newline (e.g. a
    // `//# sourceMappingURL=...` pragma, which almost every bundled file ends with),
    // gluing `}}})` straight on would swallow it into the comment and leave the
    // register call unterminated.
    layout.push(LayoutPiece::Template("\n}}})"));

    layout
}

/// push `param.name` (dot access) or `param[<raw>]` (computed, for string names — raw is already quoted)
fn push_member(sb: &mut StringBuilder<'_>, param: &str, name: &NamedMapImported<'_>) {
    sb.push_str(param);
    if name.is_ident() {
        sb.push('.');
        sb.push_str(name.name());
    } else {
        sb.push('[');
        sb.push_str(name.name());
        sb.push(']');
    }
}

/// push `{ident}_export(<name-literal>, ` into a `StringBuilder` (setter builder variant of
/// [`push_export_open`]); `Ident` names are quoted, `Literal` names carry the raw source literal
fn push_export_name_sb(sb: &mut StringBuilder<'_>, ident: &str, name: &NamedMapImported<'_>) {
    sb.push_str(ident);
    if name.is_ident() {
        sb.push_str("_export(\"");
        sb.push_str(name.name());
        sb.push_str("\", ");
    } else {
        sb.push_str("_export(");
        sb.push_str(name.name());
        sb.push_str(", ");
    }
}
