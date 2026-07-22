export interface User_record {
	id: number;
	email: string;
	name: string;
	nickname: string;
	username: string;
	avatar_filename: string;
	verified_at: string | null;
	created_at: string;
	updated_at: string | null;
	hashed_password: string | null;
	invitation_code: string;
	modules_tags: string;
	previous_hashed_password: string | null;
}

export interface User_public {
	id: number;
	email: string;
	name: string;
	nickname: string;
	username: string;
	avatar_filename: string;
	modules_tags: string;
	display_name: string;
}

export interface Session_data {
	user_id: number;
	email: string;
	name: string;
	nickname: string;
	username: string;
	avatar_filename: string;
	display_name: string;
	modules_tags: string;
	created_at: number;
}

export interface SessionStore {
	kv_get(key: string): Promise<Session_data | null>;
	kv_delete(key: string): Promise<void>;
	kv_has(key: string): Promise<boolean>;
	create_session(id: string, data: Omit<Session_data, "created_at">): Promise<void>;
	get_session(id: string): Promise<Session_data | null>;
	destroy_session(id: string): Promise<void>;
	destroy_user_sessions(user_id: number): Promise<void>;
	refresh_session(id: string, partial: Partial<Omit<Session_data, "created_at">>): Promise<void>;
	generate_session_id(): string;
	// Bulk-remove sessions past their TTL. Returns the number deleted.
	// Redis expires keys natively, so its implementation is a no-op.
	cleanup_expired(): Promise<number>;
}
