import { describe, expect, test } from "vite-plus/test";
import { Response, Headers, File } from "./main.ts";
import * as native from "../dist/index.js";

describe("Web Response API conformance", () => {
  test("default constructor creates empty 200 OK response", async () => {
    const res = new Response();
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("");
    expect(res.ok).toBe(true);
    expect(res.redirected).toBe(false);
    expect(res.type).toBe("default");
    expect(res.url).toBe("");
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("");
    expect(res.bodyUsed).toBe(false);

    const withBody = new Response("some body");
    expect(withBody.bodyUsed).toBe(false);
    expect(await withBody.text()).toBe("some body");
    expect(withBody.bodyUsed).toBe(true);
  });

  test("status and statusText customization", () => {
    const res = new Response(null, { status: 201, statusText: "Created Successfully" });
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created Successfully");
    expect(res.ok).toBe(true);

    const notFound = new Response(null, { status: 404 });
    expect(notFound.status).toBe(404);
    expect(notFound.statusText).toBe("");
    expect(notFound.ok).toBe(false);

    const serverError = new Response(null, { status: 500, statusText: "Internal Server Error" });
    expect(serverError.status).toBe(500);
    expect(serverError.statusText).toBe("Internal Server Error");
    expect(serverError.ok).toBe(false);
  });

  test("headers initialization and inspection", () => {
    const res = new Response("hello", {
      headers: {
        "X-Custom-Header": "custom-value",
        "Content-Type": "text/plain",
      },
    });
    expect(res.headers.get("x-custom-header")).toBe("custom-value");
    expect(res.headers.get("content-type")).toBe("text/plain");

    const withHeadersObj = new Response("test", {
      headers: new Headers({ "X-Foo": "Bar" }),
    });
    expect(withHeadersObj.headers.get("x-foo")).toBe("Bar");
  });

  test("body consuming methods: text, json, arrayBuffer, bytes", async () => {
    const payload = JSON.stringify({ message: "hello", count: 42 });
    const res = new Response(payload, {
      headers: { "content-type": "application/json" },
    });
    expect(await res.json()).toEqual({ message: "hello", count: 42 });
    expect(res.bodyUsed).toBe(true);

    // Body cannot be read twice
    await expect(res.text()).rejects.toThrow();
    await expect(res.arrayBuffer()).rejects.toThrow();
    await expect(res.bytes()).rejects.toThrow();

    const binRes = new Response(Buffer.from([1, 2, 3, 4]));
    const ab = await binRes.arrayBuffer();
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const bytesRes = new Response(new Uint8Array([10, 20, 30]));
    const bytes = await bytesRes.bytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(new Uint8Array([10, 20, 30]));
  });

  test("formData method parses URL-encoded body", async () => {
    const res = new Response("foo=bar&baz=qux", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const fd = await res.formData();
    expect(fd.get("foo")).toBe("bar");
    expect(fd.get("baz")).toBe("qux");
  });

  test("clone() produces an independent copy of response", async () => {
    const res = new Response("original body", {
      status: 202,
      statusText: "Accepted",
      headers: { "X-Test": "123" },
    });
    const clone = res.clone();
    expect(clone.status).toBe(202);
    expect(clone.statusText).toBe("Accepted");
    expect(clone.headers.get("x-test")).toBe("123");

    expect(await res.text()).toBe("original body");
    expect(res.bodyUsed).toBe(true);

    // Cloned response body is still unconsumed
    expect(clone.bodyUsed).toBe(false);
    expect(await clone.text()).toBe("original body");
    expect(clone.bodyUsed).toBe(true);

    // Cannot clone after body has been used
    expect(() => res.clone()).toThrow();
  });

  test("Response.json static factory creates application/json response", async () => {
    const res = Response.json({ key: "value", num: 123 }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ key: "value", num: 123 });
  });

  test("Response.redirect static factory creates 302 redirect response with location", () => {
    const res = Response.redirect("https://example.com/target", 301);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/target");

    const defaultRedirect = Response.redirect("https://example.com/default");
    expect(defaultRedirect.status).toBe(302);
    expect(defaultRedirect.headers.get("location")).toBe("https://example.com/default");

    // Invalid redirect status throws
    expect(() => Response.redirect("https://example.com", 200)).toThrow();
    expect(() => Response.redirect("https://example.com", 404)).toThrow();
    expect(() => Response.redirect("https://example.com", 500)).toThrow();
  });

  test("Response.error static factory creates network error response", () => {
    const res = Response.error();
    expect(res.type).toBe("error");
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
  });

  test("File body support", async () => {
    const file = new File("./package.json");
    const res = new Response(file);
    const text = await res.text();
    expect(text).toContain('"name": "@alloy-ts/net"');
  });

  test("blob() returns a Blob representation of the body", async () => {
    const res = new Response("blob content", {
      headers: { "content-type": "text/custom" },
    });
    const blob = await res.blob();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(12);
    expect(blob.type).toBe("text/custom");
    expect(await blob.text()).toBe("blob content");
  });

  test("ReadableStream body inspection and locking", async () => {
    const res = new Response("streamed content");
    expect(res.body).toBeInstanceOf(ReadableStream);
    const reader = res.body!.getReader();
    expect(res.bodyUsed).toBe(false);

    // When reader is active/locked, clone should fail
    expect(() => res.clone()).toThrow();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe("streamed content");
    expect(res.bodyUsed).toBe(true);
  });

  test("validation of status range and null-body statuses", () => {
    // In WHATWG fetch spec, status must be 200..=599
    expect(() => new Response(null, { status: 199 })).toThrow();
    expect(() => new Response(null, { status: 600 })).toThrow();

    // Null-body statuses cannot have a body
    expect(() => new Response("forbidden body", { status: 204 })).toThrow();
    expect(() => new Response("forbidden body", { status: 304 })).toThrow();
  });
});

describe("Native NAPI Response class", () => {
  test("native constructor and properties", async () => {
    const res = new native.Response("hello world", {
      status: 201,
      statusText: "Created",
      headers: { "x-native": "yes" },
    });
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.ok).toBe(true);
    expect(res.redirected).toBe(false);
    expect(res.url).toBe("");
    expect(res.type).toBe("default");
    expect(res.headers).toEqual({ "x-native": "yes", "content-type": "text/plain;charset=UTF-8" });
    expect(res.bodyUsed).toBe(false);

    expect(await res.text()).toBe("hello world");
    expect(res.bodyUsed).toBe(true);

    // Cannot read body twice
    await expect(res.text()).rejects.toThrow();
    await expect(res.json()).rejects.toThrow();
    await expect(res.arrayBuffer()).rejects.toThrow();
    await expect(res.bytes()).rejects.toThrow();
    expect(() => res.clone()).toThrow();
  });

  test("native clone() before consuming body", async () => {
    const res = new native.Response("clone-me", { status: 200 });
    const copy = res.clone();
    expect(await res.text()).toBe("clone-me");
    expect(res.bodyUsed).toBe(true);
    expect(copy.bodyUsed).toBe(false);
    expect(await copy.text()).toBe("clone-me");
    expect(copy.bodyUsed).toBe(true);
  });

  test("native Response.json factory", async () => {
    const res = native.Response.json({ alpha: 1, beta: "two" }, { status: 200 });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(await res.json()).toEqual({ alpha: 1, beta: "two" });
  });

  test("native Response.redirect factory and validation", () => {
    const res = native.Response.redirect("http://example.com/dest", 307);
    expect(res.status).toBe(307);
    expect(res.headers["location"]).toBe("http://example.com/dest");

    expect(() => native.Response.redirect("http://example.com", 200)).toThrow();
    expect(() => native.Response.redirect("not a valid url", 302)).toThrow();
  });

  test("native Response.error factory", () => {
    const res = native.Response.error();
    expect(res.status).toBe(0);
    expect(res.type).toBe("error");
    expect(res.ok).toBe(false);
  });

  test("native status validation and null-body rejection", () => {
    expect(() => new native.Response(null, { status: 100 })).toThrow();
    expect(() => new native.Response(null, { status: 601 })).toThrow();
    expect(() => new native.Response("body", { status: 204 })).toThrow();
    expect(() => new native.Response("body", { status: 304 })).toThrow();
    expect(new native.Response(null, { status: 204 }).status).toBe(204);
  });

  test("native UTF-8 BOM stripping, lossy replacement, and json parse failure", async () => {
    // BOM stripping
    const bomRes = new native.Response(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(await bomRes.text()).toBe("hi");

    // Lossy replacement of invalid UTF-8
    const invalidRes = new native.Response(Buffer.from([0x61, 0xff, 0x62]));
    expect(await invalidRes.text()).toBe("a\uFFFDb");

    // Invalid JSON throws SyntaxError
    const notJsonRes = new native.Response("not json");
    await expect(notJsonRes.json()).rejects.toThrow(/SyntaxError/);
  });

  test("native redirect serialization and empty statusText", () => {
    const res = native.Response.redirect("https://example.com/dest?key=val#frag", 301);
    expect(res.status).toBe(301);
    expect(res.statusText).toBe("");
    expect(res.headers["location"]).toBe("https://example.com/dest?key=val#frag");
  });

  test("native body stream, blob, and formData", async () => {
    const streamed = new native.Response("streamed content");
    expect(streamed.bodyUsed).toBe(false);
    const reader = streamed.body?.getReader();
    expect(reader).toBeTruthy();
    const first = await reader!.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe("streamed content");
    expect(streamed.bodyUsed).toBe(true);
    expect(() => streamed.clone()).toThrow();

    const empty = new native.Response();
    expect(empty.body).toBeNull();
    expect(await empty.text()).toBe("");
    expect(empty.bodyUsed).toBe(false);

    const blobRes = new native.Response("blob content", {
      headers: { "content-type": "text/custom" },
    });
    const blob = await blobRes.blob();
    expect(blob.size).toBe(12);
    expect(blob.type).toBe("text/custom");
    expect(await blob.text()).toBe("blob content");
    expect(blobRes.bodyUsed).toBe(true);

    const encoded = new native.Response("foo=bar&baz=a%20b", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const form = await encoded.formData();
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("foo")).toBe("bar");
    expect(form.get("baz")).toBe("a b");

    const boundary = "----testboundary";
    const multipart = [
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
    const multipartRes = new native.Response(multipart, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    const multipartForm = await multipartRes.formData();
    expect(multipartForm.get("title")).toBe("hello");
    const file = multipartForm.get("file");
    expect(file).toBeInstanceOf(globalThis.File);
    expect((file as globalThis.File).name).toBe("a.txt");
    expect(await (file as globalThis.File).text()).toBe("file-body");

    expect(() => new native.Response("plain").formData()).toThrow(/formData/);
    const customType = native.Response.json(
      { ok: true },
      { headers: { "Content-Type": "application/problem+json" } },
    );
    expect(customType.headers["content-type"]).toBe("application/problem+json");
  });
});

// MDN Response interface pins: https://developer.mozilla.org/en-US/docs/Web/API/Response
// These assertions lock the native NAPI class to the documented surface so a
// refactor cannot silently drift from the spec.
describe("MDN Response conformance — native NAPI class", () => {
  test("instance properties expose the MDN Response interface", () => {
    const res = new native.Response("hello", { status: 201, statusText: "Created" });
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(res.bodyUsed).toBe(false);
    expect(res.headers).toEqual({ "content-type": "text/plain;charset=UTF-8" });
    expect(res.ok).toBe(true);
    expect(res.redirected).toBe(false);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.type).toBe("default");
    expect(res.url).toBe("");
  });

  test("ok is true for 200..299 and false otherwise", () => {
    expect(new native.Response(null, { status: 200 }).ok).toBe(true);
    expect(new native.Response(null, { status: 299 }).ok).toBe(true);
    expect(new native.Response(null, { status: 300 }).ok).toBe(false);
    expect(new native.Response(null, { status: 404 }).ok).toBe(false);
    expect(native.Response.error().ok).toBe(false);
  });

  test("type is 'default' for constructed responses and 'error' for error()", () => {
    expect(new native.Response().type).toBe("default");
    expect(native.Response.error().type).toBe("error");
    expect(native.Response.redirect("https://example.test", 302).type).toBe("default");
  });

  test("statusText validates to HTTP token/obsolete-text bytes", () => {
    expect(new native.Response(null, { status: 200, statusText: "OK" }).statusText).toBe("OK");
    // bytes >= 0x80 (UTF-8 'é' = 0xc3 0xa9) are allowed
    expect(new native.Response(null, { status: 200, statusText: "café" }).statusText).toBe("café");
    // control characters (0x00, 0x0a, 0x7f) are rejected
    expect(() => new native.Response(null, { status: 200, statusText: "bad\n" })).toThrow();
    expect(() => new native.Response(null, { status: 200, statusText: "bad\x00" })).toThrow();
    expect(() => new native.Response(null, { status: 200, statusText: "bad\x7f" })).toThrow();
  });

  test("null-body statuses reject a body but accept none", () => {
    expect(() => new native.Response("x", { status: 204 })).toThrow();
    expect(() => new native.Response("x", { status: 205 })).toThrow();
    expect(() => new native.Response("x", { status: 304 })).toThrow();
    expect(new native.Response(null, { status: 204 }).status).toBe(204);
    expect(new native.Response(null, { status: 205 }).status).toBe(205);
    expect(new native.Response(null, { status: 304 }).status).toBe(304);
  });

  test("status is constrained to the 200..599 range", () => {
    expect(() => new native.Response(null, { status: 199 })).toThrow();
    expect(() => new native.Response(null, { status: 600 })).toThrow();
    expect(new native.Response(null, { status: 200 }).status).toBe(200);
    expect(new native.Response(null, { status: 599 }).status).toBe(599);
  });

  test("bytes() returns a Uint8Array view and disturbs the body", async () => {
    const res = new native.Response(Buffer.from([1, 2, 3, 4]), { status: 202 });
    const b = await res.bytes();
    expect(b).toBeInstanceOf(Uint8Array);
    expect(Array.from(b)).toEqual([1, 2, 3, 4]);
    expect(res.bodyUsed).toBe(true);
    await expect(res.bytes()).rejects.toThrow();
  });

  test("Response.error() is a network-error response", () => {
    const res = native.Response.error();
    expect(res.status).toBe(0);
    expect(res.statusText).toBe("");
    expect(res.type).toBe("error");
    expect(res.ok).toBe(false);
    expect(res.body).toBeNull();
    expect(res.bodyUsed).toBe(false);
  });

  test("clone() copies metadata and remains independent", async () => {
    const res = new native.Response("payload", {
      status: 201,
      statusText: "Created",
      headers: { "x-meta": "v" },
    });
    const copy = res.clone();
    expect(copy.status).toBe(201);
    expect(copy.statusText).toBe("Created");
    expect(copy.type).toBe("default");
    expect(copy.redirected).toBe(false);
    expect(copy.url).toBe("");
    expect(copy.headers["x-meta"]).toBe("v");
    expect(copy.bodyUsed).toBe(false);

    expect(await res.text()).toBe("payload");
    expect(res.bodyUsed).toBe(true);
    expect(await copy.text()).toBe("payload");
    // original body is now consumed
    expect(() => res.clone()).toThrow();
  });

  test("body ReadableStream disturbs bodyUsed and locks clone", async () => {
    const res = new native.Response("stream-me");
    const stream = res.body;
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(res.bodyUsed).toBe(false);
    const reader = stream!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(Buffer.from(value as Uint8Array).toString()).toBe("stream-me");
    expect(res.bodyUsed).toBe(true);
    expect(() => res.clone()).toThrow();
  });
});
