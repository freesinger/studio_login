export type UserRole = 'SYSTEM_ADMIN' | 'ACCOUNT_ADMIN' | 'SUBACCOUNT';

export interface Actor {
  userId: string;
  accountId: string;
  loginName: string;
  displayName: string;
  role: UserRole;
}

export interface ResourceConfig {
  lasBaseUrl?: string;
  lasApiKey?: string;
  arkApiKey?: string;
  tosAccessKey?: string;
  tosSecretKey?: string;
  tosBucketName?: string;
  tosUploadPrefix?: string;
  tosRegion?: string;
  tosEndpoint?: string;
  outputTosPath?: string;
  region?: string;
  customModels?: unknown;
}
