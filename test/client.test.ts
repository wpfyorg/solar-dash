import { describe, expect, it } from "vitest";
import { signature, md5 } from "../src/client";

describe("signature", () => {
  it("matches the Rust client's known fixed case (solar-dash/src/client.rs)", () => {
    const path = "/c/v0/user/login";
    const token = "";
    const timestamp = "1700000000000";
    const sig = signature(path, token, timestamp);
    const [hash] = sig.split(".");
    // Same fixed input as Rust's client::tests::signature_matches_known_case.
    const expectedInput = `${path}\\r\\n${token}\\r\\nen\\r\\n${timestamp}`;
    expect(hash).toBe(md5(expectedInput));
    // Pinned value cross-checked against `cargo test --bin waaree-dash
    // client::tests::signature_matches_known_case -- --nocapture`.
    expect(hash).toBe("93688dd15bc9cce4bb68404cc6caccb0");
  });
});
