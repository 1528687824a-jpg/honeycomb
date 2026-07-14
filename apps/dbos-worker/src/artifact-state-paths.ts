import path from "node:path";

export function stageStatePaths(input: {
  stateDir: string;
  stageIndex: number;
  stageType: string;
  kind: "output" | "test";
  attemptNo: number;
}) {
  const stageNo = input.stageIndex.toString().padStart(3, "0");
  const attemptNo = input.attemptNo.toString().padStart(2, "0");
  const baseName = `stage-${stageNo}-${input.stageType}-${input.kind}`;
  return {
    attemptPath: path.join(input.stateDir, `${baseName}-attempt-${attemptNo}.json`),
    latestPath: path.join(input.stateDir, `${baseName}.json`)
  };
}
