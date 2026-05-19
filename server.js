const http = require("http");
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

http
  .createServer((request, response) => {
    const requestedPath = request.url === "/" ? "index.html" : decodeURIComponent(request.url.slice(1));
    const filePath = path.resolve(root, requestedPath);

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      });
      response.end(data);
    });
  })
  .listen(port, host, () => {
    console.log(`http://${host}:${port}`);
  })
  .on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Порт ${port} уже занят. Запустите с другим портом: set PORT=4174 && node server.js`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });
