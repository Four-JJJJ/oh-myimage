import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installOptionalPreviewApi } from "./preview-bootstrap";
import "./styles.css";

async function bootstrap() {
  await installOptionalPreviewApi();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
