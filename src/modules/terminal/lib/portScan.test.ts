import { describe, expect, it } from "vitest";
import { scanLocalhostPorts } from "./portScan";

describe("scanLocalhostPorts", () => {
  it("detects localhost ports anywhere in text", () => {
    expect(scanLocalhostPorts("ready at http://localhost:5173/foo")).toEqual([
      5173,
    ]);
  });

  it("dedupes and ignores invalid or privileged ports", () => {
    expect(
      scanLocalhostPorts(
        "localhost:80 localhost:3000 localhost:3000 localhost:70000",
      ),
    ).toEqual([3000]);
  });
});
