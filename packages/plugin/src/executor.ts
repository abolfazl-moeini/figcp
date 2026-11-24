import type { LogEntry, RpcErrorPayload } from "@figcp/shared";

export interface ExecutionOptions {
  timeoutMs?: number;
  commitUndo?: boolean;
}

export interface ExecutionOutcome {
  ok: true;
  result: unknown;
  logs: LogEntry[];
  durationMs: number;
}

export interface ExecutionFailure {
  ok: false;
  error: RpcErrorPayload;
  logs: LogEntry[];
  durationMs: number;
}

export type ExecutionResult = ExecutionOutcome | ExecutionFailure;

/**
 * Safely converts arbitrary values (including Figma SceneNodes with circular refs)
 * into JSON-serializable plain structures.
 */
export function safeSerialize(value: unknown, maxDepth = 6, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return value.toString();
  if (t === "function" || t === "symbol") return undefined;

  if (maxDepth <= 0) return "[MaxDepth]";

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => safeSerialize(item, maxDepth - 1, seen));
  }

  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);

    // Collapse Figma SceneNode-like objects to compact descriptors so stray nodes
    // do not blow up JSON serialization or flood the MCP response.
    if (typeof obj.id === "string" && typeof obj.type === "string" && "parent" in obj) {
      return {
        id: obj.id,
        name: typeof obj.name === "string" ? obj.name : undefined,
        type: obj.type,
      };
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const serialized = safeSerialize(obj[key], maxDepth - 1, seen);
      if (serialized !== undefined) {
        out[key] = serialized;
      }
    }
    return out;
  }

  return String(value);
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg === undefined) return "undefined";
  if (typeof arg === "symbol") return String(arg);
  if (typeof arg === "function") {
    return `[Function: ${arg.name || "anonymous"}]`;
  }
  try {
    const serialized = JSON.stringify(safeSerialize(arg, 4));
    return serialized === undefined ? String(arg) : serialized;
  } catch {
    return String(arg);
  }
}

interface ExecutionState {
  aborted: boolean;
  mutated: boolean;
}

const MUTATING_METHOD_RE =
  /^(create|append|insert|remove|resize|set|add|combine|group|ungroup|delete|rename|boolean|flatten|detach|swap|commit|trigger)/i;

function createGuardedFigmaProxy<T>(target: T, state: ExecutionState): T {
  if (typeof Proxy !== "function" || target === null || typeof target !== "object") {
    return target;
  }
  if (target instanceof Uint8Array || target instanceof Promise) {
    return target;
  }

  const cache = new WeakMap<object, unknown>();

  const wrap = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== "object") return obj;
    if (obj instanceof Uint8Array || obj instanceof Promise) return obj;
    if (cache.has(obj)) return cache.get(obj);

    const proxy = new Proxy(obj as Record<string | symbol, unknown>, {
      get(innerTarget, prop) {
        if (state.aborted) {
          throw new Error("Plugin script aborted after timeout");
        }
        const value = Reflect.get(innerTarget, prop, innerTarget);
        if (typeof value === "function") {
          const propName = typeof prop === "string" ? prop : "";
          return (...args: unknown[]) => {
            if (state.aborted) {
              throw new Error("Plugin script aborted after timeout");
            }
            if (MUTATING_METHOD_RE.test(propName)) {
              state.mutated = true;
            }
            const res = (value as (...a: unknown[]) => unknown).apply(innerTarget, args);
            if (res && typeof (res as PromiseLike<unknown>).then === "function") {
              return Promise.resolve(res).then((resolved) => {
                if (state.aborted) {
                  throw new Error("Plugin script aborted after timeout");
                }
                return wrap(resolved);
              });
            }
            return wrap(res);
          };
        }
        return wrap(value);
      },
      set(innerTarget, prop, newValue) {
        if (state.aborted) {
          throw new Error("Plugin script aborted after timeout");
        }
        state.mutated = true;
        return Reflect.set(innerTarget, prop, newValue, innerTarget);
      },
    });

    cache.set(obj, proxy);
    return proxy;
  };

  return wrap(target) as T;
}

export class SerialPluginExecutor {
  private queue: Promise<void> = Promise.resolve();
  private activeId = 0;

  runTask<T>(fn: () => Promise<T> | T): Promise<T> {
    const task = () => Promise.resolve().then(fn);
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  execute(
    code: string,
    figmaApi: unknown,
    helpersApi: unknown,
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    return this.runTask(() => this.runExclusive(code, figmaApi, helpersApi, options));
  }

  private async runExclusive(
    code: string,
    figmaApi: unknown,
    helpersApi: unknown,
    options: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const executionId = ++this.activeId;
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const shouldCommitUndo = options.commitUndo ?? true;

    const logs: LogEntry[] = [];
    const state: ExecutionState = { aborted: false, mutated: false };
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    const pushLog = (level: LogEntry["level"], args: unknown[]): void => {
      if (state.aborted || executionId !== this.activeId) return;
      logs.push({ level, args: args.map(formatLogArg) });
    };

    const scopedConsole = {
      ...console,
      log: (...args: unknown[]) => pushLog("log", args),
      warn: (...args: unknown[]) => pushLog("warn", args),
      error: (...args: unknown[]) => pushLog("error", args),
      info: (...args: unknown[]) => pushLog("log", args),
      debug: (...args: unknown[]) => pushLog("log", args),
    };

    const signal = {
      get aborted() {
        return state.aborted;
      },
    };

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      console.log = (...args: unknown[]) => pushLog("log", args);
      console.warn = (...args: unknown[]) => pushLog("warn", args);
      console.error = (...args: unknown[]) => pushLog("error", args);

      const guardedFigma = createGuardedFigmaProxy(figmaApi, state);

      // Use indirect eval so it works inside Figma's QuickJS sandbox where
      // AsyncFunction constructor is restricted.
      const compiledFn = (0, eval)(
        `(async function(figma, helpers, console, signal) {\n${code}\n})`,
      ) as (f: unknown, h: unknown, c: unknown, s: unknown) => Promise<unknown>;

      const execPromise = Promise.resolve().then(() =>
        compiledFn(guardedFigma, helpersApi, scopedConsole, signal),
      );

      let rawResult: unknown;
      if (typeof setTimeout === "function") {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            state.aborted = true;
            reject(new Error(`Plugin script timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        rawResult = await Promise.race([execPromise, timeoutPromise]);
      } else {
        rawResult = await execPromise;
      }

      if (
        !state.aborted &&
        shouldCommitUndo &&
        figmaApi &&
        typeof (figmaApi as { commitUndo?: unknown }).commitUndo === "function"
      ) {
        (figmaApi as { commitUndo: () => void }).commitUndo();
      }

      return {
        ok: true,
        result: safeSerialize(rawResult),
        logs,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (
        !state.aborted &&
        shouldCommitUndo &&
        state.mutated &&
        figmaApi &&
        typeof (figmaApi as { commitUndo?: unknown }).commitUndo === "function"
      ) {
        try {
          (figmaApi as { commitUndo: () => void }).commitUndo();
        } catch {
          // Ignore commitUndo errors on failure cleanup
        }
      }
      const errorObj = err instanceof Error ? err : new Error(String(err));
      return {
        ok: false,
        error: {
          name: errorObj.name || "Error",
          message: errorObj.message || String(err),
          stack: errorObj.stack,
        },
        logs,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      state.aborted = true;
      if (timer !== undefined && typeof clearTimeout === "function") {
        clearTimeout(timer);
      }
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  }
}
