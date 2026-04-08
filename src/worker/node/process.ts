// @ts-ignore
import process from "node-external:process";
import { stderrStream, stdinStream, stdoutStream } from "../console";
import { CWD } from "../state";
let nodeProcess = process as typeof import("node:process");

(nodeProcess.features as any).require_module = false;
nodeProcess.versions.node = "25.6.1";
nodeProcess.cwd = () => {
	return CWD;
};
(nodeProcess as any).stdin = stdinStream;
(nodeProcess as any).stdout = stdoutStream;
(nodeProcess as any).stderr = stderrStream;

export default nodeProcess;
