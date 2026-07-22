import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#102a43",
        borderRadius: 14,
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "#f6c453",
          borderRadius: "50%",
          color: "#102a43",
          display: "flex",
          fontFamily: "Georgia",
          fontSize: 38,
          fontWeight: 900,
          height: 48,
          justifyContent: "center",
          width: 48,
        }}
      >
        B
      </div>
    </div>,
    size,
  );
}
