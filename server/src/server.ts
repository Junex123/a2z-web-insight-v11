import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);

const app = createApp();
app.listen(PORT, () => {
  console.log(`A-to-Z Web Insight server listening on http://localhost:${PORT}`);
});
