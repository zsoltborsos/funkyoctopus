export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  createdAt: number;
}

export interface NewPrompt {
  title: string;
  body: string;
}
