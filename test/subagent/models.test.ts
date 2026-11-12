import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveModel, type ModelSource } from "../../extensions/subagent/models.ts";

const m = (provider: string, id: string) => ({ provider, id }) as Model<any>;
const sonnet = m("bifrost", "claude-sub/claude-sonnet-5-5");
const opus = m("bifrost", "claude-sub/claude-opus-5-5");
const haiku = m("bifrost", "claude-sub/claude-haiku-5-5");
const qwen = m("bifrost", "icr-qwen/qwen3.8");
const glm = m("bifrost", "icr-glm/glm-5.3-flash");
const registry = (...models: Model<any>[]): ModelSource => ({ getAvailable: () => models });
const reg = registry(sonnet, opus, haiku, qwen, glm);
const orchestrator = { model: qwen, thinkingLevel: "high" as const };

const ok = (r: ReturnType<typeof resolveModel>) => {
	assert.ok(r.ok, r.ok ? "" : r.error);
	return r;
};

describe("resolveModel", () => {
	test("sonnet, opus and haiku resolve to the matching subscription models", () => {
		assert.equal(ok(resolveModel({ requested: "sonnet", orchestrator, registry: reg })).model, sonnet);
		assert.equal(ok(resolveModel({ requested: "opus", orchestrator, registry: reg })).model, opus);
		assert.equal(ok(resolveModel({ requested: "haiku", orchestrator, registry: reg })).model, haiku);
	});

	test("an alias model gets the orchestrator's thinking level", () => {
		assert.equal(ok(resolveModel({ requested: "opus", orchestrator, registry: reg })).thinkingLevel, "high");
	});

	test("an alias picks the highest version when several are listed", () => {
		const newer = m("bifrost", "claude-sub/claude-sonnet-5-10");
		assert.equal(ok(resolveModel({ requested: "sonnet", orchestrator, registry: registry(sonnet, newer) })).model, newer);
	});

	test("inherit and a missing model use the orchestrator's model and thinking level", () => {
		for (const requested of ["inherit", undefined]) {
			const r = ok(resolveModel({ requested, orchestrator, registry: reg }));
			assert.equal(r.model, qwen);
			assert.equal(r.thinkingLevel, "high");
		}
	});

	test("an icr-* id is accepted bare and as a full bifrost ref", () => {
		assert.equal(ok(resolveModel({ requested: "icr-glm/glm-5.3-flash", orchestrator, registry: reg })).model, glm);
		assert.equal(ok(resolveModel({ requested: "bifrost/icr-glm/glm-5.3-flash", orchestrator, registry: reg })).model, glm);
		assert.equal(ok(resolveModel({ requested: "bifrost/claude-sub/claude-opus-5-5", orchestrator, registry: reg })).model, opus);
	});

	test("the call's model overrides the definition's; the definition's applies when the call has none", () => {
		assert.equal(ok(resolveModel({ requested: "haiku", definitionModel: "opus", orchestrator, registry: reg })).model, haiku);
		assert.equal(ok(resolveModel({ definitionModel: "opus", orchestrator, registry: reg })).model, opus);
		assert.equal(ok(resolveModel({ definitionModel: "inherit", orchestrator, registry: reg })).model, qwen);
	});

	test("an unknown id is an error that lists the known ids", () => {
		const r = resolveModel({ requested: "gpt-9", orchestrator, registry: reg });
		assert.ok(!r.ok);
		assert.match(r.error, /Unknown model "gpt-9"/);
		for (const id of ["sonnet", "opus", "haiku", "inherit", "bifrost/icr-qwen/qwen3.8", "bifrost/icr-glm/glm-5.3-flash"]) assert.ok(r.error.includes(id), id);
	});

	test("an unknown id in the definition fails the same way", () => {
		assert.ok(!resolveModel({ definitionModel: "nope", orchestrator, registry: reg }).ok);
	});

	test("a bare id served by two providers prefers the orchestrator's provider, else is ambiguous", () => {
		const other = m("other", "icr-glm/glm-5.3-flash");
		assert.equal(ok(resolveModel({ requested: "icr-glm/glm-5.3-flash", orchestrator, registry: registry(other, glm) })).model, glm);
		const r = resolveModel({ requested: "icr-glm/glm-5.3-flash", orchestrator: { model: m("third", "x"), thinkingLevel: "off" }, registry: registry(other, glm) });
		assert.ok(!r.ok);
		assert.match(r.error, /ambiguous/);
	});

	test("an alias with no matching model is an error", () => {
		assert.ok(!resolveModel({ requested: "opus", orchestrator, registry: registry(sonnet) }).ok);
	});

	test("thinking: the call's level beats the definition's, which beats the orchestrator's", () => {
		assert.equal(ok(resolveModel({ requestedThinking: "low", definitionThinking: "max", orchestrator, registry: reg })).thinkingLevel, "low");
		assert.equal(ok(resolveModel({ definitionThinking: "xhigh", orchestrator, registry: reg })).thinkingLevel, "xhigh");
		assert.equal(ok(resolveModel({ orchestrator, registry: reg })).thinkingLevel, "high");
		assert.equal(ok(resolveModel({ requestedThinking: "off", orchestrator, registry: reg })).thinkingLevel, "off");
	});

	test("thinking: `inherit` means the orchestrator's level, also over a definition's", () => {
		assert.equal(ok(resolveModel({ requestedThinking: "inherit", definitionThinking: "low", orchestrator, registry: reg })).thinkingLevel, "high");
		assert.equal(ok(resolveModel({ definitionThinking: "inherit", orchestrator, registry: reg })).thinkingLevel, "high");
	});

	test("thinking: the requested level is kept on every model path", () => {
		for (const requested of ["inherit", undefined, "opus", "bifrost/icr-glm/glm-5.3-flash", "icr-glm/glm-5.3-flash", "icr-qwen/qwen3.8"]) {
			assert.equal(ok(resolveModel({ requested, requestedThinking: "medium", orchestrator, registry: reg })).thinkingLevel, "medium", String(requested));
		}
	});

	test("thinking: an invalid level, from the call or the definition, is an error naming the valid levels", () => {
		for (const input of [{ requestedThinking: "extreme" }, { definitionThinking: "Medium" }]) {
			const r = resolveModel({ ...input, orchestrator, registry: reg });
			assert.ok(!r.ok);
			assert.match(r.error, /Unknown thinking level/);
			for (const l of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit"]) assert.ok(r.error.includes(l), l);
		}
	});
});
