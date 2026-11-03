const types: Record<string, string> = { html: "text/html", css: "text/css", js: "text/javascript" };
Deno.serve({ port: 8123 }, async (req) => {
  let p = new URL(req.url).pathname;
  if (p === "/") p = "/index.html";
  try {
    const body = await Deno.readFile("web" + p);
    return new Response(body, { headers: { "content-type": (types[p.split(".").pop()!] ?? "text/plain") + "; charset=utf-8" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
