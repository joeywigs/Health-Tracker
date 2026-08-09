import React from "react";
import { createRoot } from "react-dom/client";
import WritingApp from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WritingApp />
  </React.StrictMode>
);
