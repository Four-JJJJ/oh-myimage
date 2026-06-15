import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installPreviewApi } from "./preview-api";
import "./styles.css";

installPreviewApi();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
