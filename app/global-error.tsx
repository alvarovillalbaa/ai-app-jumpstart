"use client";

export default function GlobalError({ retry }: { retry: () => void }) {
  return <html lang="en">
    <body style={{ background: "Canvas", color: "CanvasText", colorScheme: "light dark", fontFamily: "system-ui, sans-serif", margin: 0 }}>
      <main role="alert" style={{ margin: "15vh auto", maxWidth: 480, padding: 24 }}>
        <h1>Application unavailable</h1>
        <p>Something went wrong while loading the app. Please try again.</p>
        <button type="button" onClick={retry} style={{ background: "ButtonFace", color: "ButtonText", cursor: "pointer", padding: "10px 16px" }}>Try again</button>
      </main>
    </body>
  </html>;
}
