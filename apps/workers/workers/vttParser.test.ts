import { describe, expect, test } from "vitest";

import { parseVttToHtml } from "./vttParser";

describe("parseVttToHtml", () => {
  test("parses basic VTT content", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello and welcome to this video

00:00:04.000 --> 00:00:08.000
Today we're going to talk about testing`;

    const result = parseVttToHtml(vtt);
    expect(result).toContain("<p>");
    expect(result).toContain("Hello and welcome to this video");
    expect(result).toContain("Today we're going to talk about testing");
    // Timestamps must NOT appear in output
    expect(result).not.toContain("-->");
    expect(result).not.toContain("00:00");
  });

  test("deduplicates consecutive identical lines", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:03.000
Hello world

00:00:03.000 --> 00:00:04.000
Hello world

00:00:04.000 --> 00:00:05.000
Something different`;

    const result = parseVttToHtml(vtt);
    const matches = result!.match(/Hello world/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("Something different");
  });

  test("strips HTML tags from cue text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<b>Bold text</b> and <i>italic</i>`;

    const result = parseVttToHtml(vtt);
    expect(result).not.toContain("<b>");
    expect(result).not.toContain("<i>");
    expect(result).toContain("Bold text");
    expect(result).toContain("italic");
  });

  test("handles empty VTT", () => {
    const vtt = `WEBVTT`;
    const result = parseVttToHtml(vtt);
    expect(result).toBeNull();
  });

  test("handles VTT with only timestamps", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000

00:00:04.000 --> 00:00:08.000
`;
    const result = parseVttToHtml(vtt);
    expect(result).toBeNull();
  });

  test("handles cue identifiers (numbered lines)", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
First subtitle

2
00:00:04.000 --> 00:00:08.000
Second subtitle`;

    const result = parseVttToHtml(vtt);
    expect(result).toContain("First subtitle");
    expect(result).toContain("Second subtitle");
    expect(result).not.toMatch(/<p>\s*1\s*<\/p>/);
  });
});
