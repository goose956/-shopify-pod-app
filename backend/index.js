const { createServer } = require("./src/server");

const port = Number(process.env.PORT || 3000);
const app = createServer();

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
