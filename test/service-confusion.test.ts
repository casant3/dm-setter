import assert from "node:assert/strict";
import { test } from "node:test";
import { detectConfusion } from "@/core/understanding";

const CONFUSED = [
  "how long is the pod?",
  "what podcast is this for",
  "is this a podcast invite btw?",
  "are you inviting me on as a guest?",
  "so you want me to be a guest?",
  "is there a cost involved",
  "I don't pay to be on podcasts",
  "are you looking for guests",
  "happy to come on your show whenever",
  "is this a collab?",
  "so this is a free feature or a collab?",
];

const NOT_CONFUSED = [
  "raising a Series A in Q1, trying to look legit before then",
  "honestly not much comes up when people search me",
  "that makes sense, tell me more",
  "what would this look like for my launch?",
  "sounds good, when can we talk",
  "I've done a few podcasts before but nothing written",
];

test("recognises the ways prospects reveal they think this is a guest invitation", () => {
  for (const text of CONFUSED) {
    assert.ok(detectConfusion(text) !== null, `should flag: ${text}`);
  }
});

test("does not flag ordinary sales conversation as confusion", () => {
  for (const text of NOT_CONFUSED) {
    assert.equal(detectConfusion(text), null, `should not flag: ${text}`);
  }
});

test("detection is case-insensitive", () => {
  assert.ok(detectConfusion("HOW LONG IS THE POD") !== null);
  assert.ok(detectConfusion("What Podcast Is This For") !== null);
});
