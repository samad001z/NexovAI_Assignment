import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/onest";
import "./styles.css";
import DeskApp from "./DeskApp";
import PatientApp from "./PatientApp";

// Two pages, one bundle: /desk is the clinic staff view, everything else is the patient line.
const isDesk = window.location.pathname.replace(/\/+$/, "") === "/desk";
document.title = isDesk ? "Front desk, Banyan Clinic" : "Call Asha, Banyan Clinic";

createRoot(document.getElementById("root")!).render(<StrictMode>{isDesk ? <DeskApp /> : <PatientApp />}</StrictMode>);
