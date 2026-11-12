#!/usr/bin/env python3
import argparse
import json
import re
import sys

TIERS = ("COMPLEX", "MEDIUM", "SIMPLE")
OLLAMA_URL = "http://ollama-pi:11434"
CHAT_NPM = "@ai-sdk/openai-compatible"
# A gateway Responses row (ai-gateway ADR 0062): npm @ai-sdk/openai and a baseURL of exactly <gateway>/v1/<route>/v1.
RESPONSES_NPM = "@ai-sdk/openai"
RESPONSES_BASE_RE = re.compile(r"^https://[^/]+/v1/[a-z0-9.-]{1,64}/v1$")
CLAUDE_SUB_LIMITS = {
    "claude-opus-5-5": (1000000, 128000),
    "claude-sonnet-5-5": (1000000, 128000),
    "claude-haiku-5-5": (1000000, 128000),
}


def fail(msg):
    print(f"render-bifrost-config: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_target(value, where):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*/[A-Za-z0-9._:-]+", value):
        fail(f"{where}: '{value}' is not '<provider>/<model>'")
    if value.startswith("icr-claude-"):
        fail(f"{where}: '{value}' is a gateway Claude model, which is not elected for this program. Use claude-sub/* instead.")
    return tuple(value.split("/", 1))


def gateway_entry(menu, provider_id, model):
    entry = menu.get(provider_id)
    if entry is None:
        fail(f"'{provider_id}' is not claude-sub, openai, or a provider in the gateway menu")
    if model not in (entry.get("models") or {}):
        fail(f"'{provider_id}' has no model '{model}' in the gateway menu")
    npm = entry.get("npm")
    if npm == RESPONSES_NPM:
        if not RESPONSES_BASE_RE.match((entry.get("options") or {}).get("baseURL", "")):
            fail(f"'{provider_id}' is a Responses row, but its baseURL is not <gateway>/v1/<route>/v1")
    elif npm != CHAT_NPM:
        fail(f"'{provider_id}' uses '{npm}', which this setup does not route")
    return entry


def is_responses(entry):
    return entry.get("npm") == RESPONSES_NPM


PI_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


def gateway_levels(entry, model):
    """pi's thinkingLevelMap for a gateway model, from the reasoning levels its menu row lists, or None.

    pi talks to Bifrost in Anthropic format, so it sends a thinking budget per level (low 2048, medium 8192,
    high 16384 tokens) and Bifrost turns the budget into the gateway's reasoning effort. pi ignores the map's
    values on that API except null, which removes a level: pi then uses the nearest offered one. Removing the
    levels a row does not list matters for `off`, which Bifrost sends as effort `none`. The Gemini routes reject
    `none` with a 400, so `off` is offered only where the row lists `off` or `none` (Qwen, the GPT-5.6
    Responses rows), and elsewhere clamps to `low`.
    """
    variants = entry["models"][model].get("variants") or {}
    if "off" not in variants and "none" in variants:
        variants = {**variants, "off": variants["none"]}
    levels = {}
    for level in PI_LEVELS:
        v = variants.get(level)
        if v == {}:
            levels[level] = level  # offered, with no effort of its own (GLM's max). models.json takes only strings or null.
        elif isinstance(v, dict) and isinstance(v.get("reasoningEffort"), str):
            levels[level] = v["reasoningEffort"]
        else:
            levels[level] = None
    reasoning = any(levels[l] is not None for l in PI_LEVELS if l != "off")
    return levels if reasoning else None


def gateway_provider(entry, provider_id, ca_pem, key_header):
    base_url = (entry.get("options") or {}).get("baseURL", "")
    if not base_url.startswith("https://"):
        fail(f"'{provider_id}' has no https baseURL in the gateway menu")
    network = {
        "base_url": base_url,
        "default_request_timeout_in_seconds": 900,
        "allow_private_network": True,
    }
    if key_header:
        network["extra_headers"] = {key_header: "env.GATEWAY_KEY"}
    if ca_pem:
        network["ca_cert_pem"] = ca_pem
    responses = is_responses(entry)
    path = "/responses" if responses else "/chat/completions"
    kind = "responses" if responses else "chat_completion"
    return {
        "keys": [{"name": f"{provider_id}-key", "value": "env.GATEWAY_KEY", "models": ["*"], "weight": 1}],
        "network_config": network,
        "custom_provider_config": {
            "base_provider_type": "openai",
            "request_path_overrides": {kind: path, f"{kind}_stream": path},
            "allowed_requests": {
                "chat_completion": not responses,
                "chat_completion_stream": not responses,
                "responses": responses,
                "responses_stream": responses,
                "list_models": False,
                "count_tokens": False,
            },
        },
    }


def claude_sub_provider(url):
    return {
        "keys": [{"name": "claude-sub-key", "value": "env.CLAUDE_SUB_KEY", "models": ["*"], "weight": 1}],
        "network_config": {
            "base_url": url,
            "extra_headers": {"x-sub-bridge-key": "env.CLAUDE_SUB_KEY"},
            "default_request_timeout_in_seconds": 1800,
            "stream_idle_timeout_in_seconds": 1800,
            "allow_private_network": True,
        },
        "custom_provider_config": {
            "base_provider_type": "anthropic",
            "allowed_requests": {
                "chat_completion": True,
                "chat_completion_stream": True,
                "responses": True,
                "responses_stream": True,
                "list_models": False,
                "count_tokens": False,
            },
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--routing", required=True)
    ap.add_argument("--gateway-menu", default="")
    ap.add_argument("--gateway-ca", default="")
    ap.add_argument("--gateway-key-header", default="")
    ap.add_argument("--claude-sub-url", required=True)
    ap.add_argument("--vk-command", required=True)
    ap.add_argument("--bifrost-url", required=True)
    ap.add_argument("--memory-url", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pi-models-out", required=True)
    args = ap.parse_args()

    routing = json.load(open(args.routing))
    tiers = routing.get("tiers") or {}
    missing = [t for t in TIERS if t not in tiers]
    if missing:
        fail(f"routing.json tiers is missing {', '.join(missing)}")
    classifier = routing.get("classifier") or {}
    targets = {t: parse_target(tiers[t], f"tiers.{t}") for t in TIERS}
    fallback = parse_target(routing.get("fallback", "claude-sub/claude-opus-5-5"), "fallback")
    chain = [parse_target(m, "fallbacks") for m in routing.get("fallbacks", [])] or [fallback]
    listed = [parse_target(m, "models") for m in routing.get("models", [])]
    every = []
    for pm in [*targets.values(), fallback, *chain, *listed]:
        if pm not in every:
            every.append(pm)

    menu = None

    def gateway_menu():
        nonlocal menu
        if menu is None:
            if not args.gateway_menu:
                fail("routing.json uses gateway models, but GATEWAY_MENU is not set in .env")
            try:
                menu = json.load(open(args.gateway_menu))["config"]["provider"]
            except (OSError, KeyError, ValueError) as e:
                fail(f"cannot read the gateway menu at {args.gateway_menu}: {e}")
        return menu

    ca_pem = None

    def gateway_ca():
        nonlocal ca_pem
        if ca_pem is None:
            ca_pem = ""
            if args.gateway_ca:
                try:
                    ca_pem = open(args.gateway_ca).read().strip()
                except OSError as e:
                    fail(f"cannot read the gateway CA bundle at {args.gateway_ca}: {e}")
                if "BEGIN CERTIFICATE" not in ca_pem:
                    fail(f"{args.gateway_ca} is not a PEM certificate bundle")
        return ca_pem

    providers = {
        "ollama": {
            "keys": [{"name": "ollama-local", "value": "", "models": ["*"], "weight": 1,
                      "ollama_key_config": {"url": OLLAMA_URL}}],
            "network_config": {"allow_private_network": True, "default_request_timeout_in_seconds": 30},
        },
    }
    needs = set()
    limits = {}
    names = {}
    thinking = {}  # True: claude-sub (adaptive); a dict: a gateway level map; None: no thinking
    for provider, model in every:
        if provider == "claude-sub":
            if model not in CLAUDE_SUB_LIMITS:
                fail(f"claude-sub does not know the limits of '{model}'; add it to CLAUDE_SUB_LIMITS")
            providers.setdefault("claude-sub", claude_sub_provider(args.claude_sub_url))
            needs.add("CLAUDE_SUB_KEY")
            limits[(provider, model)] = CLAUDE_SUB_LIMITS[model]
            names[(provider, model)] = f"{model} (Claude subscription)"
            thinking[(provider, model)] = True
        elif provider == "openai":
            providers.setdefault("openai", {"keys": [{"name": "openai-key", "value": "env.OPENAI_API_KEY", "models": ["*"], "weight": 1}]})
            needs.add("OPENAI_API_KEY")
            limits[(provider, model)] = (128000, 16384)
            names[(provider, model)] = f"{model} (OpenAI)"
            thinking[(provider, model)] = None
        else:
            entry = gateway_entry(gateway_menu(), provider, model)
            providers.setdefault(provider, gateway_provider(entry, provider, gateway_ca(), args.gateway_key_header))
            needs.add("GATEWAY_KEY")
            lim = (entry["models"][model].get("limit") or {})
            limits[(provider, model)] = (lim.get("context", 128000), lim.get("output", 16384))
            names[(provider, model)] = f"{entry['models'][model].get('name', model)} (gateway)"
            thinking[(provider, model)] = gateway_levels(entry, model)

    provider_configs = []
    for p in providers:
        if p == "ollama":
            continue
        allowed = ["regex:claude-.*"] if p == "claude-sub" else ["*"]
        provider_configs.append({"provider": p, "allowed_models": allowed, "key_ids": ["*"]})

    def target_obj(provider, model):
        return {"provider": provider, "model": model, "weight": 1}

    rules = []
    for i, tier in enumerate(TIERS):
        provider, model = targets[tier]
        rule = {
            "id": f"auto-{tier.lower()}",
            "name": f"auto: {tier}",
            "enabled": True,
            "cel_expression": f'model == "auto" && complexity_tier == "{tier}"',
            "targets": [target_obj(provider, model)],
            "scope": "global",
            "priority": 10 * (i + 1),
        }
        rest = [f"{p}/{m}" for p, m in chain if (p, m) != (provider, model)]
        if rest:
            rule["fallbacks"] = rest
        rules.append(rule)
    rules.append({
        "id": "auto-unclassified",
        "name": "auto: unclassified",
        "enabled": True,
        "cel_expression": 'model == "auto"',
        "targets": [target_obj(*fallback)],
        "scope": "global",
        "priority": 100,
    })

    config = {
        "$schema": "https://www.getbifrost.ai/schema",
        "source_of_truth": "config.json",
        "disable_onboarding": True,
        "client": {
            "enable_logging": True,
            "disable_content_logging": True,
            "enforce_auth_on_inference": True,
            "log_retention_days": 30,
            "compat": {"should_drop_params": True},
        },
        "providers": providers,
        "governance": {
            "auth_config": {"is_enabled": True, "admin_username": "admin", "admin_password": "env.BIFROST_ADMIN_PASSWORD"},
            "virtual_keys": [{
                "id": "vk-pi",
                "name": "pi",
                "description": "pi traffic",
                "value": "env.BIFROST_VK_PI",
                "is_active": True,
                "provider_configs": provider_configs,
            }],
            "complexity_analyzer_config": {
                "classifier": "decision",
                "decision": {
                    "provider": "ollama",
                    "model": classifier.get("model", "tev1:0.8b"),
                    "timeout": classifier.get("timeout", "5s"),
                    "previous_message_count": 1,
                },
                "session": {"enabled": True},
                "keywords": {
                    "simple_keywords": ["what is a mutex?"],
                    "medium_keywords": ["add api-key auth: hash the keys, reject revoked ones, and never log them."],
                    "complex_keywords": ["design a multi-region failover plan for a stateful service and its data."],
                },
            },
            "routing_rules": rules,
        },
        "config_store": {"enabled": True, "type": "sqlite", "config": {"path": "/app/data/config.db"}},
        "logs_store": {"enabled": True, "type": "sqlite", "config": {"path": "/app/data/logs.db"}},
    }
    if args.memory_url:
        config["mcp"] = {
            "client_configs": [{
                "name": "memory",
                "endpoint_slug": "memory",
                "connection_type": "http",
                "connection_string": args.memory_url,
                "auth_type": "none",
                "tools_to_execute": ["*"],
                "tools_to_auto_execute": [],
            }],
            "tool_manager_config": {"disable_auto_tool_inject": True},
        }
        config["governance"]["virtual_keys"][0]["mcp_configs"] = [{"mcp_client_name": "memory", "tools_to_execute": ["*"]}]
    with open(args.out, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")

    tier_limits = [limits[targets[t]] for t in TIERS] + [limits[fallback]]
    pi_models = [{
        "id": "auto",
        "name": "Auto (Bifrost picks the model)",
        "reasoning": False,
        "input": ["text"],
        "contextWindow": min(c for c, _ in tier_limits),
        "maxTokens": min(o for _, o in tier_limits),
    }]
    for provider, model in every:
        context, output = limits[(provider, model)]
        entry = {
            "id": f"{provider}/{model}",
            "name": names[(provider, model)],
            "reasoning": thinking[(provider, model)] is not None,
            "input": ["text", "image"] if provider == "claude-sub" else ["text"],
            "contextWindow": context,
            "maxTokens": output,
        }
        if provider == "claude-sub":
            entry["compat"] = {"forceAdaptiveThinking": True}
        elif thinking[(provider, model)]:
            entry["thinkingLevelMap"] = thinking[(provider, model)]
        pi_models.append(entry)
    pi = {
        "$schema": "https://pi.dev/schemas/models.schema.json",
        "providers": {
            "bifrost": {
                "baseUrl": args.bifrost_url,
                "api": "anthropic-messages",
                "apiKey": args.vk_command,
                "headers": {"x-bf-vk": args.vk_command},
                "models": pi_models,
            }
        },
    }
    with open(args.pi_models_out, "w") as f:
        json.dump(pi, f, indent=2)
        f.write("\n")

    for name in sorted(needs):
        print(name)


if __name__ == "__main__":
    main()
