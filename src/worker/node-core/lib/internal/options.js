const optionValues = Object.freeze({
	'--abort-on-uncaught-exception': false,
	'--insecure-http-parser': false,
	'--max-http-header-size': 16 * 1024,
	'--use-env-proxy': false,
});

export function getOptionValue(name) {
	return optionValues[name];
}

export function getCLIOptionsInfo() {
	return {};
}

export function getOptionsAsFlagsFromBinding() {
	return [];
}

export function getAllowUnauthorized() {
	return false;
}

export function getEmbedderOptions() {
	return {};
}

export function generateConfigJsonSchema() {
	return {};
}

export function refreshOptions() {}

export default {
	getCLIOptionsInfo,
	getOptionValue,
	getOptionsAsFlagsFromBinding,
	getAllowUnauthorized,
	getEmbedderOptions,
	generateConfigJsonSchema,
	refreshOptions,
};
