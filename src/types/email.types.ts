export interface ParsedEmail {
  id: string;
  subject: string;
  sender: {
    name: string;
    email: string;
  };
  to: {
    name: string;
    email: string;
  }[];
  cc?: {
    name: string;
    email: string;
  }[];
  date: string;
  body: string;
  preview: string;
  read: boolean;
  starred: boolean;
  folder: string;
  attachments?: never[];
} 