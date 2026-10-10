interface RpcSink {
  write(data: string): unknown
  flush(): unknown
}

/** A successful write includes the asynchronous flush on platforms with buffered pipes. */
export async function writeRpc(
  stdin: RpcSink | number | null | undefined,
  value: Record<string, unknown>,
): Promise<void> {
  if (stdin === undefined || stdin === null || typeof stdin === "number")
    throw new Error("pi backend: Pi stdin is unavailable")
  stdin.write(`${JSON.stringify(value)}\n`)
  await stdin.flush()
}
