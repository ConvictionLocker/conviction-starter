import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvictionExample } from "./conviction-example";

createRoot(document.getElementById("root")!).render(
  <StrictMode><ConvictionExample /></StrictMode>,
);
