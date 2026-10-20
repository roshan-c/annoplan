export type Color = "yellow" | "green" | "blue" | "pink" | "purple";
export const colors: Color[] = ["yellow", "green", "blue", "pink", "purple"];
export interface Document {
  id: string;
  path: string;
  content_hash: string;
  format: "md" | "pdf" | "docx";
  title: string;
  added_at: string;
  last_opened_at: string;
  annotation_count: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Share {
  id: string;
  document_id: string;
  share_key: string;
  owner_token: string;
  url: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  last_event_at: string | null;
}
export interface Annotation {
  source?: "app" | "mcp" | "share";
  agent_client?: string | null;
  author_id?: string | null;
  author_name?: string | null;
  share_id?: string | null;
  id: string;
  document_id: string;
  color: Color;
  quote: string;
  prefix: string;
  suffix: string;
  start_offset: number;
  end_offset: number;
  page: number | null;
  rects_json: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}
export interface Opened {
  document: Document;
  data: string;
}
export interface SearchResult {
  document: Document;
  annotation: Annotation;
}
export interface Heading {
  id: string;
  text: string;
  level: number;
}
