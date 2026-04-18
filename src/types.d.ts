declare module 'screenshot-desktop' {
  interface ScreenshotOptions {
    format?: 'png' | 'jpg';
    screen?: string | number;
  }

  interface Display {
    id: string | number;
    name?: string;
    primary?: boolean;
  }

  function screenshot(options?: ScreenshotOptions): Promise<Buffer>;

  namespace screenshot {
    function listDisplays(): Promise<Display[]>;
  }

  export = screenshot;
}

declare module 'clipboardy' {
  const clipboardy: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
  export default clipboardy;
}
