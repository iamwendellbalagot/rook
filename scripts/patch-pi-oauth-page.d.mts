export interface PiOAuthPageOptions {
  title: string;
  heading: string;
  message: string;
  details?: string;
}

export function renderRookOAuthPage(options: PiOAuthPageOptions): string;

export function patchPiOAuthPageModule(source: string): {
  source: string;
  changed: boolean;
};

export function patchInstalledPiOAuthPage(): Promise<void>;
