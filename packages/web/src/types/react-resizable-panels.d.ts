declare module "react-resizable-panels" {
  import * as React from "react";

  export interface PanelGroupProps extends React.HTMLAttributes<HTMLDivElement> {
    direction: "horizontal" | "vertical";
    children?: React.ReactNode;
  }

  export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
    defaultSize?: number;
    minSize?: number;
  }

  export interface PanelResizeHandleProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
  }

  export const PanelGroup: React.ComponentType<PanelGroupProps>;
  export const Panel: React.ComponentType<PanelProps>;
  export const PanelResizeHandle: React.ComponentType<PanelResizeHandleProps>;
}
