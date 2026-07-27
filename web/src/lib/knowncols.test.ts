import { describe, it, expect } from "vitest";
import { extractUrls } from "./urls";

// A login URL alone on an otherwise clean screen — the case the Links list
// exists for, and the one wrap-width INFERENCE cannot serve, because a single
// URL on a wide pane produces too few full-width rows to find a repeat.
const url =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=000000000000-exampleclientidexampleclientid00.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fexample.com%2Foauth%2Fcallback&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify&state=EXAMPLESTATEVALUE0000000000000&access_type=offline";
const wrap = (s: string, c: number) => {
  const o: string[] = [];
  for (let i = 0; i < s.length; i += c) o.push(s.slice(i, i + c));
  return o.join("\n");
};

describe("quiet pane, known pty width", () => {
  for (const cols of [80, 100, 120, 140, 160, 200]) {
    const pane = "Please visit the following URL to authorize:\n" + wrap(url, cols) + "\n$ ";
    it(`recovers the whole URL at ${cols} cols`, () => {
      expect(extractUrls(pane, 100, cols)[0]).toBe(url);
    });
  }
  it("still works with no known width on a busy pane (inference fallback)", () => {
    const filler = Array.from({ length: 4 }, (_, i) =>
      wrap(`[${i}] ` + "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(6), 120)).join("\n");
    expect(extractUrls(filler + "\n" + wrap(url, 120), 100, 0)[0]).toBe(url);
  });
  it("a wrong/stale width does not corrupt an unwrapped URL", () => {
    expect(extractUrls(`see ${url} now`, 100, 137)[0]).toBe(url);
  });
  it("does not glue prose when the width happens to match", () => {
    const line = "x".repeat(120);
    expect(extractUrls(`${line}\nNext section begins here`, 100, 120)).toEqual([]);
  });
});
