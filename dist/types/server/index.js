import { createServer, getServerPort } from "@devvit/web/server";
import { serverOnRequest } from "./server.js";
const server = createServer(serverOnRequest);
const port = getServerPort();
server.on("error", (err) => console.error(`server error; ${err.stack}`));
server.listen(port);
//# sourceMappingURL=index.js.map