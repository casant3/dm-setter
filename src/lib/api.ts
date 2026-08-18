import { NextResponse } from "next/server";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Turns a thrown error into a JSON response without leaking a stack trace to the client. */
export function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("[api]", error);
  const status = /not found/i.test(message) ? 404 : 500;
  return fail(message, status);
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}
