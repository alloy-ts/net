/**
 * MDN Request conformance for the *native* NAPI class.
 *
 * The public `Request` in request.ts is a Web facade, so these assertions pin
 * the internal buffered transport object instead:
 * https://developer.mozilla.org/en-US/docs/Web/API/Request
 */
import { describe, expect, test } from "vite-plus/test";
import * as native from "../dist/index.js";

// Port 1 is deliberately unreachable: every start() below is expected to be
// rejected by its abort flag before any socket is opened.
const url = "http://127.0.0.1:1/echo";

function multipartBody(boundary: string): string {
  return [
    `--${boundary}`,
    'Content-Disposition: form-data; name="title"',
    "",
    "hello",
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="a.txt"',
    "Content-Type: text/plain",
    "",
    "file-body",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

describe("MDN Request conformance — native NAPI class", () => {
  test("body is a ReadableStream (or null) and disturbs bodyUsed", async () => {
    const request = new native.Request(url, { method: "POST", body: "streamed" });
    expect(request.bodyUsed).toBe(false);
    const stream = request.body;
    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = stream!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe("streamed");
    expect(request.bodyUsed).toBe(true);
    expect(() => request.clone()).toThrow();
    await expect(request.text()).rejects.toThrow(/consumed|already/);

    const empty = new native.Request(url);
    expect(empty.body).toBeNull();
    expect(await empty.text()).toBe("");
    expect(empty.bodyUsed).toBe(false);
  });

  test("blob() returns a typed Blob and consumes the body", async () => {
    const request = new native.Request(url, {
      method: "POST",
      body: "blob content",
      headers: { "content-type": "text/custom; charset=utf-8" },
    });
    const blob = await request.blob();
    expect(blob.size).toBe(12);
    expect(blob.type).toBe("text/custom");
    expect(await blob.text()).toBe("blob content");
    expect(request.bodyUsed).toBe(true);
    await expect(request.blob()).rejects.toThrow(/consumed|already/);
  });

  test("formData() parses urlencoded and multipart bodies", async () => {
    const encoded = new native.Request(url, {
      method: "POST",
      body: "foo=bar&baz=a%20b",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const form = await encoded.formData();
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("foo")).toBe("bar");
    expect(form.get("baz")).toBe("a b");

    const boundary = "----requestboundary";
    const multipart = new native.Request(url, {
      method: "POST",
      body: multipartBody(boundary),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    const parsed = await multipart.formData();
    expect(parsed.get("title")).toBe("hello");
    const file = parsed.get("file");
    expect(file).toBeInstanceOf(globalThis.File);
    expect((file as globalThis.File).name).toBe("a.txt");
    expect(await (file as globalThis.File).text()).toBe("file-body");

    expect(() => new native.Request(url, { method: "POST", body: "plain" }).formData()).toThrow(
      /formData/,
    );
  });

  test("destination is empty and referrerPolicy validates and inherits", () => {
    const request = new native.Request(url);
    expect(request.destination).toBe("");
    expect(request.referrerPolicy).toBe("");

    const withPolicy = new native.Request(url, { referrerPolicy: "no-referrer" });
    expect(withPolicy.referrerPolicy).toBe("no-referrer");
    expect(new native.Request(withPolicy).referrerPolicy).toBe("no-referrer");
    expect(
      new native.Request(url, { referrerPolicy: "strict-origin-when-cross-origin" }).referrerPolicy,
    ).toBe("strict-origin-when-cross-origin");

    expect(() => new native.Request(url, { referrerPolicy: "invalid" })).toThrow(/referrerPolicy/);
  });

  test("signal is the native abort handle and stops start()", async () => {
    const request = new native.Request(url);
    expect(request.signal).toBeInstanceOf(native.AbortFlag);
    request.signal.abort();
    await expect(request.start()).rejects.toThrow(/aborted/i);

    const other = new native.Request(url);
    const flag = new native.AbortFlag();
    flag.abort();
    await expect(other.start(flag)).rejects.toThrow(/aborted/i);
  });

  test("clone preserves the new members and shares the abort handle", async () => {
    const original = new native.Request(url, {
      method: "POST",
      body: "payload",
      referrerPolicy: "origin",
    });
    const copy = original.clone();
    expect(copy.referrerPolicy).toBe("origin");
    expect(copy.destination).toBe("");
    expect(copy.signal).toBeInstanceOf(native.AbortFlag);
    expect(await copy.text()).toBe("payload");

    // The cloned signal shares the same AtomicBool as the original.
    copy.signal.abort();
    await expect(original.start()).rejects.toThrow(/aborted/i);
  });
});
