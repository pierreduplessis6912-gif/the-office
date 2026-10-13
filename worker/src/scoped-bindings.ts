// A business's view of the three stores every business shares: the notes store (KV), the file storage (R2) and the memory index (Vectorize).
//
// Found 2026-10-12, before any real data moved: in object mode all businesses share ONE notes store, ONE file bucket and ONE memory index, but the application keys them with ids that
// are per-business counters (`customer:1`, `character:1`, a memory filtered by customerId 1, a vector id `pmf-<row id>-...`), and a file route that reads whatever key it is given. Two
// businesses' customer number 1 would have read and overwritten each other's notes and memories. The stage 2b tests covered the databases only, so they could not see it.
//
// scopeBindings() gives an object a view of each store in which EVERY key, id and query is confined to its own business: notes under `b:<id>:`, files under `b/<id>/`, memories in the
// business's own Vectorize NAMESPACE (with ids prefixed as well). The scope is DENY-BY-DEFAULT: only the methods the application actually uses are offered, so a new call that was never
// scoped fails loudly instead of quietly reading another business's data (a test also checks every call the source makes against these lists).
import type { Env } from "./types";

type Fn = (...args: unknown[]) => unknown;

// Builds a view that offers ONLY the listed methods (each already scoped); everything else throws, and plain properties pass through.
function offer<T extends object>(target: T, label: string, methods: Record<string, Fn>): T {
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === "string" && key in methods) return methods[key];
      const v = Reflect.get(t, key, t);
      if (typeof v === "function") {
        return () => {
          throw new Error(`${label}.${String(key)} is not available to a business: it has not been scoped (add it to scoped-bindings.ts)`);
        };
      }
      return v;
    },
  });
}

export const SCOPED_KV_METHODS = ["get", "getWithMetadata", "put", "delete", "list"] as const;
export const SCOPED_R2_METHODS = ["get", "head", "put", "delete", "list"] as const;
export const SCOPED_VECTOR_METHODS = ["upsert", "insert", "query", "getByIds", "deleteByIds"] as const;

export const kvPrefix = (businessId: string): string => `b:${businessId}:`;
export const r2Prefix = (businessId: string): string => `b/${businessId}/`;
export const vectorPrefix = (businessId: string): string => `${businessId}:`;

export function scopeKv(kv: KVNamespace, businessId: string): KVNamespace {
  const p = kvPrefix(businessId);
  const raw = kv as unknown as Record<string, Fn>;
  return offer(kv, "CUSTOMER_NOTES", {
    get: (key, ...rest) => raw.get.call(kv, p + String(key), ...rest),
    getWithMetadata: (key, ...rest) => raw.getWithMetadata.call(kv, p + String(key), ...rest),
    put: (key, ...rest) => raw.put.call(kv, p + String(key), ...rest),
    delete: (key) => raw.delete.call(kv, p + String(key)),
    list: async (options) => {
      const o = (options ?? {}) as { prefix?: string };
      const listed = (await raw.list.call(kv, { ...o, prefix: p + (o.prefix ?? "") })) as { keys: { name: string }[] };
      return { ...listed, keys: listed.keys.map((k) => ({ ...k, name: k.name.slice(p.length) })) };
    },
  });
}

export function scopeR2(bucket: R2Bucket, businessId: string): R2Bucket {
  const p = r2Prefix(businessId);
  const raw = bucket as unknown as Record<string, Fn>;
  return offer(bucket, "OFFICE_VAULT", {
    get: (key, ...rest) => raw.get.call(bucket, p + String(key), ...rest),
    head: (key) => raw.head.call(bucket, p + String(key)),
    put: (key, ...rest) => raw.put.call(bucket, p + String(key), ...rest),
    delete: (keys) => raw.delete.call(bucket, Array.isArray(keys) ? keys.map((k) => p + String(k)) : p + String(keys)),
    list: async (options) => {
      const o = (options ?? {}) as { prefix?: string };
      const listed = (await raw.list.call(bucket, { ...o, prefix: p + (o.prefix ?? "") })) as { objects: { key: string }[] };
      return { ...listed, objects: listed.objects.map((obj) => ({ ...obj, key: obj.key.slice(p.length) })) };
    },
  });
}

export function scopeVectors(index: VectorizeIndex, businessId: string): VectorizeIndex {
  const p = vectorPrefix(businessId);
  const raw = index as unknown as Record<string, Fn>;
  const scoped = (vectors: unknown) => (vectors as { id: string }[]).map((v) => ({ ...v, id: p + v.id, namespace: businessId }));
  return offer(index, "MEMORY", {
    upsert: (vectors) => raw.upsert.call(index, scoped(vectors)),
    insert: (vectors) => raw.insert.call(index, scoped(vectors)),
    // The query is confined to this business's namespace whatever options the caller passes (any namespace the caller asks for is overwritten).
    query: async (vector, options) => {
      const result = (await raw.query.call(index, vector, { ...((options ?? {}) as object), namespace: businessId })) as { matches?: { id: string }[] };
      return { ...result, matches: (result.matches ?? []).map((m) => ({ ...m, id: m.id.startsWith(p) ? m.id.slice(p.length) : m.id })) };
    },
    // Found on the real index (2026-10-13): the vectors come back with their STORED, prefixed ids, so the prefix is removed, as it is for a search.
    getByIds: async (ids) => {
      const found = (await raw.getByIds.call(index, (ids as string[]).map((i) => p + i))) as { id: string }[];
      return found.map((v) => ({ ...v, id: v.id.startsWith(p) ? v.id.slice(p.length) : v.id }));
    },
    deleteByIds: (ids) => raw.deleteByIds.call(index, (ids as string[]).map((i) => p + i)),
  });
}

// An object's whole environment, with the three shared stores confined to its business. A store that is not bound is left alone.
export function scopeBindings(env: Env, businessId: string): Env {
  return {
    ...env,
    ...(env.CUSTOMER_NOTES ? { CUSTOMER_NOTES: scopeKv(env.CUSTOMER_NOTES, businessId) } : {}),
    ...(env.OFFICE_VAULT ? { OFFICE_VAULT: scopeR2(env.OFFICE_VAULT, businessId) } : {}),
    ...(env.MEMORY ? { MEMORY: scopeVectors(env.MEMORY, businessId) } : {}),
  };
}
