const express = require("express");
const path = require("path");
const app = express();
const PORT = 3000;

// Папка с веб-приложением
app.use(express.static("../click-pay/cometa_front/build"));

app.listen(PORT, () => {
  console.log(`Web App доступен по адресу http://localhost:${PORT}`);
});
