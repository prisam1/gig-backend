// Database types for supabase-js, in the format `supabase gen types typescript` produces.
// Mirrors supabase/migrations. After changing the schema, regenerate instead of editing:
//   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '13.0.5';
  };
  public: {
    Tables: {
      consents: {
        Row: {
          accepted_at: string;
          app_version: string | null;
          id: number;
          ip_address: string | null;
          type: string;
          user_id: number;
          version: string;
        };
        Insert: {
          accepted_at?: string;
          app_version?: string | null;
          id?: never;
          ip_address?: string | null;
          type: string;
          user_id: number;
          version: string;
        };
        Update: {
          accepted_at?: string;
          app_version?: string | null;
          id?: never;
          ip_address?: string | null;
          type?: string;
          user_id?: number;
          version?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'consents_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      files: {
        Row: {
          bucket: string;
          created_at: string;
          id: number;
          mime_type: string;
          object_key: string;
          owner_id: number;
          public_id: string;
          purpose: Database['public']['Enums']['file_purpose'];
          scan_status: Database['public']['Enums']['file_scan_status'];
          size_bytes: number;
          updated_at: string;
        };
        Insert: {
          bucket: string;
          created_at?: string;
          id?: never;
          mime_type: string;
          object_key: string;
          owner_id: number;
          public_id?: string;
          purpose: Database['public']['Enums']['file_purpose'];
          scan_status?: Database['public']['Enums']['file_scan_status'];
          size_bytes: number;
          updated_at?: string;
        };
        Update: {
          bucket?: string;
          created_at?: string;
          id?: never;
          mime_type?: string;
          object_key?: string;
          owner_id?: number;
          public_id?: string;
          purpose?: Database['public']['Enums']['file_purpose'];
          scan_status?: Database['public']['Enums']['file_scan_status'];
          size_bytes?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'files_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      follows: {
        Row: {
          created_at: string;
          followee_id: number;
          follower_id: number;
        };
        Insert: {
          created_at?: string;
          followee_id: number;
          follower_id: number;
        };
        Update: {
          created_at?: string;
          followee_id?: number;
          follower_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'follows_followee_id_fkey';
            columns: ['followee_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'follows_follower_id_fkey';
            columns: ['follower_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      kyc_documents: {
        Row: {
          document_type: Database['public']['Enums']['kyc_document_type'];
          file_id: number;
          submission_id: number;
        };
        Insert: {
          document_type: Database['public']['Enums']['kyc_document_type'];
          file_id: number;
          submission_id: number;
        };
        Update: {
          document_type?: Database['public']['Enums']['kyc_document_type'];
          file_id?: number;
          submission_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'kyc_documents_file_id_fkey';
            columns: ['file_id'];
            isOneToOne: false;
            referencedRelation: 'files';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'kyc_documents_submission_id_fkey';
            columns: ['submission_id'];
            isOneToOne: false;
            referencedRelation: 'kyc_submissions';
            referencedColumns: ['id'];
          },
        ];
      };
      kyc_submissions: {
        Row: {
          created_at: string;
          id: number;
          provider: string;
          public_id: string;
          reason: string | null;
          reference: string | null;
          reviewed_at: string | null;
          reviewer_id: number | null;
          status: Database['public']['Enums']['kyc_submission_status'];
          tier: Database['public']['Enums']['verified_tier'];
          updated_at: string;
          user_id: number;
        };
        Insert: {
          created_at?: string;
          id?: never;
          provider?: string;
          public_id?: string;
          reason?: string | null;
          reference?: string | null;
          reviewed_at?: string | null;
          reviewer_id?: number | null;
          status?: Database['public']['Enums']['kyc_submission_status'];
          tier: Database['public']['Enums']['verified_tier'];
          updated_at?: string;
          user_id: number;
        };
        Update: {
          created_at?: string;
          id?: never;
          provider?: string;
          public_id?: string;
          reason?: string | null;
          reference?: string | null;
          reviewed_at?: string | null;
          reviewer_id?: number | null;
          status?: Database['public']['Enums']['kyc_submission_status'];
          tier?: Database['public']['Enums']['verified_tier'];
          updated_at?: string;
          user_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'kyc_submissions_reviewer_id_fkey';
            columns: ['reviewer_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'kyc_submissions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      lookup_options: {
        Row: {
          active: boolean;
          code: string;
          label: string;
          sort_order: number;
          type: Database['public']['Enums']['lookup_type'];
        };
        Insert: {
          active?: boolean;
          code: string;
          label: string;
          sort_order?: number;
          type: Database['public']['Enums']['lookup_type'];
        };
        Update: {
          active?: boolean;
          code?: string;
          label?: string;
          sort_order?: number;
          type?: Database['public']['Enums']['lookup_type'];
        };
        Relationships: [];
      };
      tier_history: {
        Row: {
          created_at: string;
          from_tier: Database['public']['Enums']['membership_tier'];
          id: number;
          to_tier: Database['public']['Enums']['membership_tier'];
          user_id: number;
        };
        Insert: {
          created_at?: string;
          from_tier: Database['public']['Enums']['membership_tier'];
          id?: never;
          to_tier: Database['public']['Enums']['membership_tier'];
          user_id: number;
        };
        Update: {
          created_at?: string;
          from_tier?: Database['public']['Enums']['membership_tier'];
          id?: never;
          to_tier?: Database['public']['Enums']['membership_tier'];
          user_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'tier_history_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      user_preferences: {
        Row: {
          created_at: string;
          option_code: string;
          type: Database['public']['Enums']['preference_type'];
          user_id: number;
        };
        Insert: {
          created_at?: string;
          option_code: string;
          type: Database['public']['Enums']['preference_type'];
          user_id: number;
        };
        Update: {
          created_at?: string;
          option_code?: string;
          type?: Database['public']['Enums']['preference_type'];
          user_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'user_preferences_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      user_profiles: {
        Row: {
          avatar_file_id: number | null;
          created_at: string;
          experience: string | null;
          job_profile: string | null;
          location: string | null;
          name: string | null;
          other_job: string | null;
          updated_at: string;
          user_id: number;
        };
        Insert: {
          avatar_file_id?: number | null;
          created_at?: string;
          experience?: string | null;
          job_profile?: string | null;
          location?: string | null;
          name?: string | null;
          other_job?: string | null;
          updated_at?: string;
          user_id: number;
        };
        Update: {
          avatar_file_id?: number | null;
          created_at?: string;
          experience?: string | null;
          job_profile?: string | null;
          location?: string | null;
          name?: string | null;
          other_job?: string | null;
          updated_at?: string;
          user_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'user_profiles_avatar_file_id_fkey';
            columns: ['avatar_file_id'];
            isOneToOne: false;
            referencedRelation: 'files';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_profiles_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      users: {
        Row: {
          auth_user_id: string;
          created_at: string;
          email: string | null;
          id: number;
          kyc_status: Database['public']['Enums']['kyc_status'];
          phone: string | null;
          public_id: string;
          requested_tier: Database['public']['Enums']['verified_tier'] | null;
          status: Database['public']['Enums']['user_status'];
          tier: Database['public']['Enums']['membership_tier'];
          updated_at: string;
        };
        Insert: {
          auth_user_id: string;
          created_at?: string;
          email?: string | null;
          id?: never;
          kyc_status?: Database['public']['Enums']['kyc_status'];
          phone?: string | null;
          public_id?: string;
          requested_tier?: Database['public']['Enums']['verified_tier'] | null;
          status?: Database['public']['Enums']['user_status'];
          tier?: Database['public']['Enums']['membership_tier'];
          updated_at?: string;
        };
        Update: {
          auth_user_id?: string;
          created_at?: string;
          email?: string | null;
          id?: never;
          kyc_status?: Database['public']['Enums']['kyc_status'];
          phone?: string | null;
          public_id?: string;
          requested_tier?: Database['public']['Enums']['verified_tier'] | null;
          status?: Database['public']['Enums']['user_status'];
          tier?: Database['public']['Enums']['membership_tier'];
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      replace_user_preferences: {
        Args: { p_preferences: Json; p_user_id: number };
        Returns: undefined;
      };
      submit_kyc: {
        Args: {
          p_consent: Json;
          p_documents: Json;
          p_tier: Database['public']['Enums']['verified_tier'];
          p_user_id: number;
        };
        Returns: string;
      };
    };
    Enums: {
      file_purpose: 'AVATAR' | 'KYC_DOCUMENT' | 'REVIEW_EVIDENCE';
      file_scan_status: 'PENDING' | 'CLEAN' | 'INFECTED';
      kyc_document_type:
        | 'ID_PROOF'
        | 'ADDRESS_PROOF'
        | 'TAX_ID'
        | 'INCORPORATION_CERTIFICATE'
        | 'AUTHORISATION_LETTER';
      kyc_status: 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
      kyc_submission_status: 'PENDING' | 'APPROVED' | 'REJECTED';
      lookup_type:
        | 'JOB_PROFILE'
        | 'FOCUS'
        | 'RISK'
        | 'STYLE'
        | 'SECTOR'
        | 'ASSET_CLASS'
        | 'APPRECIATION_TAG'
        | 'CONCERN_TAG'
        | 'RATING_FACTOR'
        | 'RISK_FACTOR'
        | 'INVESTOR_TYPE';
      membership_tier: 'OBSERVER' | 'PRIVE' | 'INSTITUTIONAL';
      preference_type: 'FOCUS' | 'RISK' | 'STYLE' | 'SECTOR';
      user_status: 'ACTIVE' | 'SUSPENDED';
      verified_tier: 'PRIVE' | 'INSTITUTIONAL';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Update'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];

export const Constants = {
  public: {
    Enums: {
      file_purpose: ['AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE'],
      file_scan_status: ['PENDING', 'CLEAN', 'INFECTED'],
      kyc_document_type: [
        'ID_PROOF',
        'ADDRESS_PROOF',
        'TAX_ID',
        'INCORPORATION_CERTIFICATE',
        'AUTHORISATION_LETTER',
      ],
      kyc_status: ['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED'],
      kyc_submission_status: ['PENDING', 'APPROVED', 'REJECTED'],
      lookup_type: [
        'JOB_PROFILE',
        'FOCUS',
        'RISK',
        'STYLE',
        'SECTOR',
        'ASSET_CLASS',
        'APPRECIATION_TAG',
        'CONCERN_TAG',
        'RATING_FACTOR',
        'RISK_FACTOR',
        'INVESTOR_TYPE',
      ],
      membership_tier: ['OBSERVER', 'PRIVE', 'INSTITUTIONAL'],
      preference_type: ['FOCUS', 'RISK', 'STYLE', 'SECTOR'],
      user_status: ['ACTIVE', 'SUSPENDED'],
      verified_tier: ['PRIVE', 'INSTITUTIONAL'],
    },
  },
} as const;
