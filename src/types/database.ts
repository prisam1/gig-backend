// Database types for supabase-js, in the format `supabase gen types typescript` produces.
// Mirrors supabase/migrations. After changing the schema, regenerate instead of editing:
//   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '13';
  };
  public: {
    Tables: {
      companies: {
        Row: {
          id: string;
          slug: string;
          name: string;
          asset_class: Database['public']['Enums']['asset_class'];
          country: Database['public']['Enums']['market_country'];
          logo_url: string | null;
          description: string | null;
          verified: boolean;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          asset_class: Database['public']['Enums']['asset_class'];
          country: Database['public']['Enums']['market_country'];
          logo_url?: string | null;
          description?: string | null;
          verified?: boolean;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          asset_class?: Database['public']['Enums']['asset_class'];
          country?: Database['public']['Enums']['market_country'];
          logo_url?: string | null;
          description?: string | null;
          verified?: boolean;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      company_stats: {
        Row: {
          company_id: string;
          review_count: number;
          score: number;
          relevance: number;
          avg_transparency: number;
          avg_responsiveness: number;
          avg_ease_of_process: number;
          avg_trustworthiness: number;
          avg_overall_satisfaction: number;
          positive_pct: number;
          neutral_pct: number;
          negative_pct: number;
          dominant_sentiment: Database['public']['Enums']['sentiment'] | null;
          resolved_pct: number;
          in_progress_pct: number;
          unresolved_pct: number;
          not_contacted_pct: number;
          dominant_resolution: Database['public']['Enums']['resolution_bucket'] | null;
          reviews_30d: number;
          score_change_12m: number;
          last_review_at: string | null;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          review_count?: number;
          score?: number;
          relevance?: number;
          avg_transparency?: number;
          avg_responsiveness?: number;
          avg_ease_of_process?: number;
          avg_trustworthiness?: number;
          avg_overall_satisfaction?: number;
          positive_pct?: number;
          neutral_pct?: number;
          negative_pct?: number;
          dominant_sentiment?: Database['public']['Enums']['sentiment'] | null;
          resolved_pct?: number;
          in_progress_pct?: number;
          unresolved_pct?: number;
          not_contacted_pct?: number;
          dominant_resolution?: Database['public']['Enums']['resolution_bucket'] | null;
          reviews_30d?: number;
          score_change_12m?: number;
          last_review_at?: string | null;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          review_count?: number;
          score?: number;
          relevance?: number;
          avg_transparency?: number;
          avg_responsiveness?: number;
          avg_ease_of_process?: number;
          avg_trustworthiness?: number;
          avg_overall_satisfaction?: number;
          positive_pct?: number;
          neutral_pct?: number;
          negative_pct?: number;
          dominant_sentiment?: Database['public']['Enums']['sentiment'] | null;
          resolved_pct?: number;
          in_progress_pct?: number;
          unresolved_pct?: number;
          not_contacted_pct?: number;
          dominant_resolution?: Database['public']['Enums']['resolution_bucket'] | null;
          reviews_30d?: number;
          score_change_12m?: number;
          last_review_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'company_stats_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: true;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
      company_tags: {
        Row: {
          company_id: string;
          tag: string;
          sort_order: number;
        };
        Insert: {
          company_id: string;
          tag: string;
          sort_order?: number;
        };
        Update: {
          company_id?: string;
          tag?: string;
          sort_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'company_tags_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
      company_trend_points: {
        Row: {
          company_id: string;
          month: string;
          review_count: number;
          overall_sum: number;
          positive_count: number;
        };
        Insert: {
          company_id: string;
          month: string;
          review_count: number;
          overall_sum: number;
          positive_count: number;
        };
        Update: {
          company_id?: string;
          month?: string;
          review_count?: number;
          overall_sum?: number;
          positive_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'company_trend_points_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
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
      issuer_tags: {
        Row: {
          issuer_id: string;
          tag: string;
          sort_order: number;
        };
        Insert: {
          issuer_id: string;
          tag: string;
          sort_order?: number;
        };
        Update: {
          issuer_id?: string;
          tag?: string;
          sort_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'issuer_tags_issuer_id_fkey';
            columns: ['issuer_id'];
            isOneToOne: false;
            referencedRelation: 'issuers';
            referencedColumns: ['id'];
          },
        ];
      };
      issuers: {
        Row: {
          id: string;
          slug: string;
          name: string;
          instrument: string;
          asset_type: string;
          exchange: string | null;
          open_date: string | null;
          close_date: string | null;
          is_listed: boolean;
          min_lot: number | null;
          lot_unit: string;
          price_min: number | null;
          price_max: number | null;
          offer_size: number | null;
          currency: string;
          use_of_funds: string | null;
          lock_in: string | null;
          pre_post_ratio: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          instrument: string;
          asset_type: string;
          exchange?: string | null;
          open_date?: string | null;
          close_date?: string | null;
          is_listed?: boolean;
          min_lot?: number | null;
          lot_unit?: string;
          price_min?: number | null;
          price_max?: number | null;
          offer_size?: number | null;
          currency?: string;
          use_of_funds?: string | null;
          lock_in?: string | null;
          pre_post_ratio?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          instrument?: string;
          asset_type?: string;
          exchange?: string | null;
          open_date?: string | null;
          close_date?: string | null;
          is_listed?: boolean;
          min_lot?: number | null;
          lot_unit?: string;
          price_min?: number | null;
          price_max?: number | null;
          offer_size?: number | null;
          currency?: string;
          use_of_funds?: string | null;
          lock_in?: string | null;
          pre_post_ratio?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
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
      review_attachments: {
        Row: {
          review_id: string;
          storage_path: string;
          doc_type: string;
          created_at: string;
        };
        Insert: {
          review_id: string;
          storage_path: string;
          doc_type: string;
          created_at?: string;
        };
        Update: {
          review_id?: string;
          storage_path?: string;
          doc_type?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_attachments_review_id_fkey';
            columns: ['review_id'];
            isOneToOne: false;
            referencedRelation: 'reviews';
            referencedColumns: ['id'];
          },
        ];
      };
      review_tags: {
        Row: {
          review_id: string;
          tag_type: string;
          code: string;
        };
        Insert: {
          review_id: string;
          tag_type: string;
          code: string;
        };
        Update: {
          review_id?: string;
          tag_type?: string;
          code?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_tags_review_id_fkey';
            columns: ['review_id'];
            isOneToOne: false;
            referencedRelation: 'reviews';
            referencedColumns: ['id'];
          },
        ];
      };
      review_versions: {
        Row: {
          id: number;
          review_id: string;
          change_type: Database['public']['Enums']['review_change_type'];
          from_value: string | null;
          to_value: string | null;
          note: string | null;
          actor_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          review_id: string;
          change_type: Database['public']['Enums']['review_change_type'];
          from_value?: string | null;
          to_value?: string | null;
          note?: string | null;
          actor_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          review_id?: string;
          change_type?: Database['public']['Enums']['review_change_type'];
          from_value?: string | null;
          to_value?: string | null;
          note?: string | null;
          actor_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_versions_review_id_fkey';
            columns: ['review_id'];
            isOneToOne: false;
            referencedRelation: 'reviews';
            referencedColumns: ['id'];
          },
        ];
      };
      reviews: {
        Row: {
          id: string;
          receipt_no: string;
          user_id: string;
          author_name: string;
          company_id: string;
          country: Database['public']['Enums']['market_country'];
          asset_class: Database['public']['Enums']['asset_class'];
          product_scheme: string;
          investment_year: number | null;
          investment_status: Database['public']['Enums']['investment_status'];
          sentiment: Database['public']['Enums']['sentiment'];
          detailed_review: string | null;
          mixed_review: string | null;
          negative_description: string | null;
          reinvest_status: Database['public']['Enums']['reinvest_status'] | null;
          m_transparency: number;
          m_responsiveness: number;
          m_ease_of_process: number;
          m_trustworthiness: number;
          m_overall_satisfaction: number;
          resolution_status: Database['public']['Enums']['resolution_status'];
          follow_up_note: string | null;
          display_mode: Database['public']['Enums']['display_mode'];
          allow_contact: boolean;
          declarations_version: string;
          declarations_accepted_at: string;
          status: Database['public']['Enums']['review_status'];
          moderation_note: string | null;
          published_at: string | null;
          idempotency_key: string | null;
          request_hash: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          receipt_no?: string;
          user_id: string;
          author_name?: string;
          company_id: string;
          country: Database['public']['Enums']['market_country'];
          asset_class: Database['public']['Enums']['asset_class'];
          product_scheme?: string;
          investment_year?: number | null;
          investment_status: Database['public']['Enums']['investment_status'];
          sentiment: Database['public']['Enums']['sentiment'];
          detailed_review?: string | null;
          mixed_review?: string | null;
          negative_description?: string | null;
          reinvest_status?: Database['public']['Enums']['reinvest_status'] | null;
          m_transparency: number;
          m_responsiveness: number;
          m_ease_of_process: number;
          m_trustworthiness: number;
          m_overall_satisfaction: number;
          resolution_status: Database['public']['Enums']['resolution_status'];
          follow_up_note?: string | null;
          display_mode?: Database['public']['Enums']['display_mode'];
          allow_contact?: boolean;
          declarations_version: string;
          declarations_accepted_at?: string;
          status?: Database['public']['Enums']['review_status'];
          moderation_note?: string | null;
          published_at?: string | null;
          idempotency_key?: string | null;
          request_hash?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          receipt_no?: string;
          user_id?: string;
          author_name?: string;
          company_id?: string;
          country?: Database['public']['Enums']['market_country'];
          asset_class?: Database['public']['Enums']['asset_class'];
          product_scheme?: string;
          investment_year?: number | null;
          investment_status?: Database['public']['Enums']['investment_status'];
          sentiment?: Database['public']['Enums']['sentiment'];
          detailed_review?: string | null;
          mixed_review?: string | null;
          negative_description?: string | null;
          reinvest_status?: Database['public']['Enums']['reinvest_status'] | null;
          m_transparency?: number;
          m_responsiveness?: number;
          m_ease_of_process?: number;
          m_trustworthiness?: number;
          m_overall_satisfaction?: number;
          resolution_status?: Database['public']['Enums']['resolution_status'];
          follow_up_note?: string | null;
          display_mode?: Database['public']['Enums']['display_mode'];
          allow_contact?: boolean;
          declarations_version?: string;
          declarations_accepted_at?: string;
          status?: Database['public']['Enums']['review_status'];
          moderation_note?: string | null;
          published_at?: string | null;
          idempotency_key?: string | null;
          request_hash?: string | null;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'reviews_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
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
      company_cards: {
        Row: {
          id: string | null;
          slug: string | null;
          name: string | null;
          description: string | null;
          asset_class: Database['public']['Enums']['asset_class'] | null;
          country: Database['public']['Enums']['market_country'] | null;
          logo_url: string | null;
          verified: boolean | null;
          created_at: string | null;
          tags: string[] | null;
          review_count: number | null;
          score: number | null;
          relevance: number | null;
          avg_transparency: number | null;
          avg_responsiveness: number | null;
          avg_ease_of_process: number | null;
          avg_trustworthiness: number | null;
          avg_overall_satisfaction: number | null;
          positive_pct: number | null;
          neutral_pct: number | null;
          negative_pct: number | null;
          dominant_sentiment: Database['public']['Enums']['sentiment'] | null;
          resolved_pct: number | null;
          in_progress_pct: number | null;
          unresolved_pct: number | null;
          not_contacted_pct: number | null;
          dominant_resolution: Database['public']['Enums']['resolution_bucket'] | null;
          reviews_30d: number | null;
          score_change_12m: number | null;
          last_review_at: string | null;
        };
        Relationships: [];
      };
      review_feed: {
        Row: {
          id: string | null;
          company_id: string | null;
          country: Database['public']['Enums']['market_country'] | null;
          asset_class: Database['public']['Enums']['asset_class'] | null;
          product_scheme: string | null;
          investment_year: number | null;
          investment_status: Database['public']['Enums']['investment_status'] | null;
          sentiment: Database['public']['Enums']['sentiment'] | null;
          detailed_review: string | null;
          mixed_review: string | null;
          negative_description: string | null;
          reinvest_status: Database['public']['Enums']['reinvest_status'] | null;
          m_transparency: number | null;
          m_responsiveness: number | null;
          m_ease_of_process: number | null;
          m_trustworthiness: number | null;
          m_overall_satisfaction: number | null;
          avg_rating: number | null;
          resolution_status: Database['public']['Enums']['resolution_status'] | null;
          resolution_bucket: Database['public']['Enums']['resolution_bucket'] | null;
          follow_up_note: string | null;
          display_mode: Database['public']['Enums']['display_mode'] | null;
          author_name: string | null;
          appreciations: string[] | null;
          concerns: string[] | null;
          contact_statuses: string[] | null;
          created_at: string | null;
          published_at: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'reviews_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      name_initials: {
        Args: { full_name: string };
        Returns: string;
      };
      recompute_all_company_stats: {
        Args: never;
        Returns: undefined;
      };
      recompute_company_stats: {
        Args: { p_company_id: string };
        Returns: undefined;
      };
      replace_user_preferences: {
        Args: { p_preferences: Json; p_user_id: number };
        Returns: undefined;
      };
      search_companies: {
        Args: {
          p_q?: string;
          p_sentiments?: Database['public']['Enums']['sentiment'][];
          p_asset_classes?: Database['public']['Enums']['asset_class'][];
          p_resolutions?: Database['public']['Enums']['resolution_bucket'][];
          p_scores?: number[];
          p_countries?: Database['public']['Enums']['market_country'][];
          p_investment_statuses?: Database['public']['Enums']['investment_status'][];
          p_years?: number[];
          p_years_before?: number;
        };
        Returns: Database['public']['Views']['company_cards']['Row'][];
        SetofOptions: {
          from: '*';
          to: 'company_cards';
          isOneToOne: false;
          isSetofReturn: true;
        };
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
      submit_review: {
        Args: {
          p_user_id: string;
          p_idempotency_key: string | null;
          p_request_hash: string | null;
          p_author_name: string;
          p_company_id: string;
          p_country: Database['public']['Enums']['market_country'];
          p_asset_class: Database['public']['Enums']['asset_class'];
          p_product_scheme: string;
          p_investment_year: number | null;
          p_investment_status: Database['public']['Enums']['investment_status'];
          p_sentiment: Database['public']['Enums']['sentiment'];
          p_detailed_review: string | null;
          p_mixed_review: string | null;
          p_negative_description: string | null;
          p_reinvest_status: Database['public']['Enums']['reinvest_status'] | null;
          p_appreciations: string[];
          p_concerns: string[];
          p_contact_statuses: string[];
          p_evidence_paths: string[];
          p_evidence_doc_types: string[];
          p_m_transparency: number;
          p_m_responsiveness: number;
          p_m_ease_of_process: number;
          p_m_trustworthiness: number;
          p_m_overall_satisfaction: number;
          p_resolution_status: Database['public']['Enums']['resolution_status'];
          p_follow_up_note: string | null;
          p_display_mode: Database['public']['Enums']['display_mode'];
          p_allow_contact: boolean;
          p_declarations_version: string;
        };
        Returns: {
          id: string;
          receipt_no: string;
          status: Database['public']['Enums']['review_status'];
          created_at: string;
        }[];
      };
      update_review_resolution: {
        Args: {
          p_user_id: string;
          p_review_id: string;
          p_resolution_status: Database['public']['Enums']['resolution_status'];
          p_follow_up_note: string | null;
          p_update_note: boolean;
        };
        Returns: {
          id: string;
          resolution_status: Database['public']['Enums']['resolution_status'];
          follow_up_note: string | null;
          updated_at: string;
        }[];
      };
    };
    Enums: {
      asset_class: 'EQ' | 'MF' | 'INS' | 'BND' | 'PMS' | 'BRK' | 'RE' | 'CRY';
      display_mode: 'FULL_NAME' | 'INITIALS' | 'ANONYMOUS';
      file_purpose: 'AVATAR' | 'KYC_DOCUMENT' | 'REVIEW_EVIDENCE';
      file_scan_status: 'PENDING' | 'CLEAN' | 'INFECTED';
      investment_status: 'CURRENTLY_INVESTED' | 'EXITED' | 'NEVER_INVESTED';
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
      market_country: 'IN' | 'AE' | 'OTHER';
      membership_tier: 'OBSERVER' | 'PRIVE' | 'INSTITUTIONAL';
      preference_type: 'FOCUS' | 'RISK' | 'STYLE' | 'SECTOR';
      reinvest_status: 'YES' | 'MAYBE' | 'NO';
      resolution_bucket: 'RESOLVED' | 'IN_PROGRESS' | 'UNRESOLVED' | 'NOT_CONTACTED';
      resolution_status:
        | 'NOT_CONTACTED'
        | 'CONTACTED'
        | 'IN_PROGRESS'
        | 'RESOLVED'
        | 'PARTIALLY_RESOLVED'
        | 'CLOSED_UNRESOLVED';
      review_change_type:
        | 'SUBMITTED'
        | 'PUBLISHED'
        | 'CHANGES_REQUESTED'
        | 'REJECTED'
        | 'REMOVED'
        | 'RESOLUTION_UPDATED';
      review_status:
        'PENDING_MODERATION' | 'PUBLISHED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'REMOVED';
      sentiment: 'Positive' | 'Neutral' | 'Negative';
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
export type Views<T extends keyof PublicSchema['Views']> = PublicSchema['Views'][T]['Row'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];

/** Enum values as runtime tuples, for zod schemas. `satisfies` keeps them in sync with the types. */
export const Constants = {
  public: {
    Enums: {
      asset_class: ['EQ', 'MF', 'INS', 'BND', 'PMS', 'BRK', 'RE', 'CRY'],
      display_mode: ['FULL_NAME', 'INITIALS', 'ANONYMOUS'],
      file_purpose: ['AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE'],
      file_scan_status: ['PENDING', 'CLEAN', 'INFECTED'],
      investment_status: ['CURRENTLY_INVESTED', 'EXITED', 'NEVER_INVESTED'],
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
      market_country: ['IN', 'AE', 'OTHER'],
      membership_tier: ['OBSERVER', 'PRIVE', 'INSTITUTIONAL'],
      preference_type: ['FOCUS', 'RISK', 'STYLE', 'SECTOR'],
      reinvest_status: ['YES', 'MAYBE', 'NO'],
      resolution_bucket: ['RESOLVED', 'IN_PROGRESS', 'UNRESOLVED', 'NOT_CONTACTED'],
      resolution_status: [
        'NOT_CONTACTED',
        'CONTACTED',
        'IN_PROGRESS',
        'RESOLVED',
        'PARTIALLY_RESOLVED',
        'CLOSED_UNRESOLVED',
      ],
      review_status: [
        'PENDING_MODERATION',
        'PUBLISHED',
        'CHANGES_REQUESTED',
        'REJECTED',
        'REMOVED',
      ],
      sentiment: ['Positive', 'Neutral', 'Negative'],
      user_status: ['ACTIVE', 'SUSPENDED'],
      verified_tier: ['PRIVE', 'INSTITUTIONAL'],
    },
  },
} as const satisfies {
  public: { Enums: { [K in keyof PublicSchema['Enums']]?: readonly PublicSchema['Enums'][K][] } };
};

// Compile error if a runtime tuple above is missing a value of its database enum.
type RuntimeEnums = (typeof Constants)['public']['Enums'];
type EnumGaps = {
  [K in keyof RuntimeEnums]: Exclude<PublicSchema['Enums'][K], RuntimeEnums[K][number]>;
};
type AssertNoGaps<T extends { [K in keyof T]: never }> = T;
export type EnumsAreComplete = AssertNoGaps<EnumGaps>;
