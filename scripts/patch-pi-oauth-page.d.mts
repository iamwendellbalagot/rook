export interface PiOAuthPageOptions {
  title: string;
  heading: string;
  message: string;
  details?: string;
}

export interface PiOAuthDesign {
  css: string;
  traveler: string;
  scarf: string;
  castle: string;
  emblem: string;
  wordmark: string;
  favicon: string;
}

export function renderRookOAuthPage(options: PiOAuthPageOptions): string;

export function loadRookOAuthDesign(): Promise<PiOAuthDesign>;

export function patchPiOAuthPageModule(
  source: string,
  design: PiOAuthDesign,
): {
  source: string;
  changed: boolean;
};

export function patchInstalledPiOAuthPage(): Promise<void>;
