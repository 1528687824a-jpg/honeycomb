import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ArtifactDestinationPathError,
  artifactDestinationApprovalTarget,
  artifactDestinationRootKey,
  isArtifactPathInsideRoot,
  normalizeArtifactDestinationApprovalTarget,
  normalizeArtifactDestinationRootPath,
  resolveArtifactCustomDestination,
  resolveArtifactWorkspaceDestination,
  sanitizeArtifactDeliveryFileName,
  validateArtifactDeliveryPath
} from "../packages/shared/src/artifact-destination-policy";

test("Windows destination roots are stable across slash and case variants", () => {
  assert.equal(normalizeArtifactDestinationRootPath("C:/Users/Test/Output/"), "C:\\Users\\Test\\Output");
  assert.equal(
    artifactDestinationRootKey("C:\\Users\\Test\\Output"),
    "c:\\users\\test\\output"
  );
  const target = artifactDestinationApprovalTarget("c:\\users\\test\\output");
  assert.equal(normalizeArtifactDestinationApprovalTarget(target), "c:\\users\\test\\output");
});

test("network, device, relative and reserved Windows roots are rejected", () => {
  for (const candidate of [
    "\\\\server\\share",
    "\\\\?\\C:\\Output",
    "relative\\output",
    "C:\\Output\\CON"
  ]) {
    assert.throws(
      () => normalizeArtifactDestinationRootPath(candidate),
      ArtifactDestinationPathError,
      candidate
    );
  }
});

test("workspace destinations accept only clean relative directories inside the registered root", () => {
  assert.deepEqual(resolveArtifactWorkspaceDestination("C:\\Projects\\Tea", "exports/posters"), {
    rootPath: "C:\\Projects\\Tea",
    rootPathKey: "c:\\projects\\tea",
    relativeDirectory: "exports/posters",
    directoryPath: "C:\\Projects\\Tea\\exports\\posters",
    flavor: "windows"
  });
  for (const candidate of ["..\\outside", "C:\\outside", "exports/../outside", "\\\\server\\share"]) {
    assert.throws(
      () => resolveArtifactWorkspaceDestination("C:\\Projects\\Tea", candidate),
      ArtifactDestinationPathError,
      candidate
    );
  }
});

test("custom destinations must stay inside a separately granted root", () => {
  assert.deepEqual(
    resolveArtifactCustomDestination("D:\\Approved", "D:\\Approved\\Campaign\\Final"),
    {
      rootPath: "D:\\Approved",
      rootPathKey: "d:\\approved",
      relativeDirectory: "Campaign/Final",
      directoryPath: "D:\\Approved\\Campaign\\Final",
      flavor: "windows"
    }
  );
  assert.equal(isArtifactPathInsideRoot("D:\\Approved", "D:\\Approved-Other"), false);
  assert.throws(
    () => resolveArtifactCustomDestination("D:\\Approved", "D:\\Outside"),
    ArtifactDestinationPathError
  );
});

test("delivery file names remove traversal, device names and Windows-invalid characters", () => {
  assert.equal(sanitizeArtifactDeliveryFileName("..\\茶道:宣传海报?.png"), "茶道_宣传海报_.png");
  assert.equal(sanitizeArtifactDeliveryFileName("CON.png"), "_CON.png");
  assert.equal(sanitizeArtifactDeliveryFileName("..."), "honeycomb-artifact");
});

test("workspace/custom receipts must remain in the authorized directory with the requested name", () => {
  const base = {
    destinationPath: "D:\\Approved\\Campaign",
    requestedFileName: "tea-poster.png"
  };
  assert.deepEqual(
    validateArtifactDeliveryPath({ ...base, deliveredPath: "D:\\Approved\\Campaign\\tea-poster.png" }),
    { valid: true }
  );
  assert.deepEqual(
    validateArtifactDeliveryPath({ ...base, deliveredPath: "D:\\Approved\\Campaign\\tea-poster-2.png" }),
    { valid: true }
  );
  assert.deepEqual(
    validateArtifactDeliveryPath({ ...base, deliveredPath: "D:\\Approved\\Other\\tea-poster.png" }),
    { valid: false, reason: "delivery_path_outside_destination" }
  );
  assert.deepEqual(
    validateArtifactDeliveryPath({ ...base, deliveredPath: "D:\\Approved\\Campaign\\other.png" }),
    { valid: false, reason: "delivery_file_name_mismatch" }
  );
});

test("POSIX destinations remain available for a later macOS backend", () => {
  assert.deepEqual(resolveArtifactWorkspaceDestination("/Users/test/project", "output/posters"), {
    rootPath: "/Users/test/project",
    rootPathKey: "/Users/test/project",
    relativeDirectory: "output/posters",
    directoryPath: "/Users/test/project/output/posters",
    flavor: "posix"
  });
});
