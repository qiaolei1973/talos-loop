import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

// A single QueryClient for the app. Default staleTime: 0 means every
// refetchInterval tick triggers a background refresh, which is what a
// near-real-time dashboard wants. React Query dedupes concurrent requests
// for the same key, so StrictMode's double effect invocation issues only one
// network request per key.
const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
