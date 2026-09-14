import { createMockApp } from "./app.js";

const PORT = Number(process.env.MOCK_PORT ?? 4100);

createMockApp().listen(PORT, () => {
  console.log(`Mock target site listening on http://localhost:${PORT} (routes: /messy, /clean, /redirect-me, /slow)`);
});
