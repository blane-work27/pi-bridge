import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
	if (specifier.startsWith("@earendil-works/")) {
		const dir = process.env.PI_SDK_DIR;
		const req = createRequire(pathToFileURL(join(dir, "noop.js")));
		try {
			return await next(pathToFileURL(req.resolve(specifier)).href, context);
		} catch {
			return next(specifier, { ...context, parentURL: pathToFileURL(join(dir, "noop.js")).href });
		}
	}
	return next(specifier, context);
}
