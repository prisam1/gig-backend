// Database types in the `supabase gen types typescript` format, matching supabase/migrations.
// Regenerate once the project is linked:
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
      credit_ledger: {
        Row: {
          id: number;
          user_id: string;
          delta: number;
          balance_after: number;
          reason: Database['public']['Enums']['credit_reason'];
          ref_type: string | null;
          ref_id: string | null;
          note: string | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          user_id: string;
          delta: number;
          balance_after: number;
          reason: Database['public']['Enums']['credit_reason'];
          ref_type?: string | null;
          ref_id?: string | null;
          note?: string | null;
          created_at?: string;
        };
        Update: {
          id?: never;
          user_id?: string;
          delta?: number;
          balance_after?: number;
          reason?: Database['public']['Enums']['credit_reason'];
          ref_type?: string | null;
          ref_id?: string | null;
          note?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'credit_ledger_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      device_tokens: {
        Row: {
          token: string;
          user_id: string;
          platform: Database['public']['Enums']['device_platform'];
          app_version: string | null;
          created_at: string;
          last_seen_at: string;
        };
        Insert: {
          token: string;
          user_id: string;
          platform: Database['public']['Enums']['device_platform'];
          app_version?: string | null;
          created_at?: string;
          last_seen_at?: string;
        };
        Update: {
          token?: string;
          user_id?: string;
          platform?: Database['public']['Enums']['device_platform'];
          app_version?: string | null;
          created_at?: string;
          last_seen_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'device_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      fx_rates: {
        Row: {
          currency: Database['public']['Enums']['currency_code'];
          per_usd: number;
          as_of: string;
        };
        Insert: {
          currency: Database['public']['Enums']['currency_code'];
          per_usd: number;
          as_of?: string;
        };
        Update: {
          currency?: Database['public']['Enums']['currency_code'];
          per_usd?: number;
          as_of?: string;
        };
        Relationships: [];
      };
      learn_items: {
        Row: {
          id: string;
          title: string;
          summary: string | null;
          format: Database['public']['Enums']['learn_format'];
          category: string | null;
          access: Database['public']['Enums']['content_access'];
          thumbnail_url: string | null;
          content_url: string | null;
          duration_seconds: number | null;
          download_path: string | null;
          rating_avg: number;
          rating_count: number;
          status: Database['public']['Enums']['content_status'];
          published_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          summary?: string | null;
          format: Database['public']['Enums']['learn_format'];
          category?: string | null;
          access?: Database['public']['Enums']['content_access'];
          thumbnail_url?: string | null;
          content_url?: string | null;
          duration_seconds?: number | null;
          download_path?: string | null;
          rating_avg?: number;
          rating_count?: number;
          status?: Database['public']['Enums']['content_status'];
          published_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          summary?: string | null;
          format?: Database['public']['Enums']['learn_format'];
          category?: string | null;
          access?: Database['public']['Enums']['content_access'];
          thumbnail_url?: string | null;
          content_url?: string | null;
          duration_seconds?: number | null;
          download_path?: string | null;
          rating_avg?: number;
          rating_count?: number;
          status?: Database['public']['Enums']['content_status'];
          published_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      learn_ratings: {
        Row: {
          learn_item_id: string;
          user_id: string;
          rating: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          learn_item_id: string;
          user_id: string;
          rating: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          learn_item_id?: string;
          user_id?: string;
          rating?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'learn_ratings_learn_item_id_fkey';
            columns: ['learn_item_id'];
            isOneToOne: false;
            referencedRelation: 'learn_items';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'learn_ratings_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          type: Database['public']['Enums']['notification_type'];
          title: string;
          body: string;
          data: Json;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: Database['public']['Enums']['notification_type'];
          title: string;
          body: string;
          data?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          type?: Database['public']['Enums']['notification_type'];
          title?: string;
          body?: string;
          data?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      pool_members: {
        Row: {
          roadshow_id: string;
          user_id: string;
          capital_interest: number;
          ledger_entry_id: number;
          idempotency_key: string;
          request_hash: string;
          created_at: string;
        };
        Insert: {
          roadshow_id: string;
          user_id: string;
          capital_interest: number;
          ledger_entry_id: number;
          idempotency_key: string;
          request_hash: string;
          created_at?: string;
        };
        Update: {
          roadshow_id?: string;
          user_id?: string;
          capital_interest?: number;
          ledger_entry_id?: number;
          idempotency_key?: string;
          request_hash?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'pool_members_ledger_entry_id_fkey';
            columns: ['ledger_entry_id'];
            isOneToOne: false;
            referencedRelation: 'credit_ledger';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'pool_members_roadshow_id_fkey';
            columns: ['roadshow_id'];
            isOneToOne: false;
            referencedRelation: 'roadshows';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'pool_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      roadshow_documents: {
        Row: {
          id: string;
          roadshow_id: string;
          title: string;
          doc_type: string;
          storage_path: string;
          size_bytes: number | null;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          roadshow_id: string;
          title: string;
          doc_type: string;
          storage_path: string;
          size_bytes?: number | null;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          roadshow_id?: string;
          title?: string;
          doc_type?: string;
          storage_path?: string;
          size_bytes?: number | null;
          sort_order?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'roadshow_documents_roadshow_id_fkey';
            columns: ['roadshow_id'];
            isOneToOne: false;
            referencedRelation: 'roadshows';
            referencedColumns: ['id'];
          },
        ];
      };
      roadshow_financials: {
        Row: {
          roadshow_id: string;
          fiscal_year: number;
          revenue: number | null;
          ebitda: number | null;
          net_profit: number | null;
          total_assets: number | null;
          total_liabilities: number | null;
          net_worth: number | null;
          total_debt: number | null;
          cash_and_equivalents: number | null;
          operating_cash_flow: number | null;
          eps: number | null;
        };
        Insert: {
          roadshow_id: string;
          fiscal_year: number;
          revenue?: number | null;
          ebitda?: number | null;
          net_profit?: number | null;
          total_assets?: number | null;
          total_liabilities?: number | null;
          net_worth?: number | null;
          total_debt?: number | null;
          cash_and_equivalents?: number | null;
          operating_cash_flow?: number | null;
          eps?: number | null;
        };
        Update: {
          roadshow_id?: string;
          fiscal_year?: number;
          revenue?: number | null;
          ebitda?: number | null;
          net_profit?: number | null;
          total_assets?: number | null;
          total_liabilities?: number | null;
          net_worth?: number | null;
          total_debt?: number | null;
          cash_and_equivalents?: number | null;
          operating_cash_flow?: number | null;
          eps?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'roadshow_financials_roadshow_id_fkey';
            columns: ['roadshow_id'];
            isOneToOne: false;
            referencedRelation: 'roadshows';
            referencedColumns: ['id'];
          },
        ];
      };
      roadshow_improvement_votes: {
        Row: {
          roadshow_id: string;
          user_id: string;
          expectation: Database['public']['Enums']['pool_expectation'];
        };
        Insert: {
          roadshow_id: string;
          user_id: string;
          expectation: Database['public']['Enums']['pool_expectation'];
        };
        Update: {
          roadshow_id?: string;
          user_id?: string;
          expectation?: Database['public']['Enums']['pool_expectation'];
        };
        Relationships: [
          {
            foreignKeyName: 'roadshow_improvement_votes_roadshow_id_user_id_fkey';
            columns: ['roadshow_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'pool_members';
            referencedColumns: ['roadshow_id', 'user_id'];
          },
        ];
      };
      roadshow_offers: {
        Row: {
          id: string;
          roadshow_id: string;
          user_id: string;
          offer_price: number | null;
          currency: Database['public']['Enums']['currency_code'];
          expected_roi: number | null;
          expected_irr: number | null;
          entry_load: number | null;
          exit_load: number | null;
          lock_in_months: number | null;
          min_investment: number | null;
          allotment_terms: string | null;
          payment_terms: string | null;
          notes: string | null;
          status: Database['public']['Enums']['offer_status'];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          roadshow_id: string;
          user_id: string;
          offer_price?: number | null;
          currency: Database['public']['Enums']['currency_code'];
          expected_roi?: number | null;
          expected_irr?: number | null;
          entry_load?: number | null;
          exit_load?: number | null;
          lock_in_months?: number | null;
          min_investment?: number | null;
          allotment_terms?: string | null;
          payment_terms?: string | null;
          notes?: string | null;
          status?: Database['public']['Enums']['offer_status'];
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          roadshow_id?: string;
          user_id?: string;
          offer_price?: number | null;
          currency?: Database['public']['Enums']['currency_code'];
          expected_roi?: number | null;
          expected_irr?: number | null;
          entry_load?: number | null;
          exit_load?: number | null;
          lock_in_months?: number | null;
          min_investment?: number | null;
          allotment_terms?: string | null;
          payment_terms?: string | null;
          notes?: string | null;
          status?: Database['public']['Enums']['offer_status'];
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'roadshow_offers_roadshow_id_fkey';
            columns: ['roadshow_id'];
            isOneToOne: false;
            referencedRelation: 'roadshows';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'roadshow_offers_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      roadshow_questions: {
        Row: {
          id: string;
          roadshow_id: string;
          user_id: string;
          category: Database['public']['Enums']['question_category'];
          question: string;
          status: Database['public']['Enums']['question_status'];
          featured: boolean;
          answer: string | null;
          answered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          roadshow_id: string;
          user_id: string;
          category?: Database['public']['Enums']['question_category'];
          question: string;
          status?: Database['public']['Enums']['question_status'];
          featured?: boolean;
          answer?: string | null;
          answered_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          roadshow_id?: string;
          user_id?: string;
          category?: Database['public']['Enums']['question_category'];
          question?: string;
          status?: Database['public']['Enums']['question_status'];
          featured?: boolean;
          answer?: string | null;
          answered_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'roadshow_questions_roadshow_id_fkey';
            columns: ['roadshow_id'];
            isOneToOne: false;
            referencedRelation: 'roadshows';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'roadshow_questions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      roadshows: {
        Row: {
          id: string;
          slug: string;
          issuer_id: string;
          title: string;
          summary: string | null;
          type_of_issue: string;
          instruments: string;
          no_of_instruments: number | null;
          offer_price: number | null;
          currency: Database['public']['Enums']['currency_code'];
          lock_in: string | null;
          maturity: string | null;
          convertibility: string | null;
          callable: boolean;
          coupon_rate: number | null;
          risk_factors: string[];
          opens_at: string | null;
          closes_at: string;
          pool_enabled: boolean;
          status: Database['public']['Enums']['content_status'];
          published_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          issuer_id: string;
          title: string;
          summary?: string | null;
          type_of_issue: string;
          instruments: string;
          no_of_instruments?: number | null;
          offer_price?: number | null;
          currency?: Database['public']['Enums']['currency_code'];
          lock_in?: string | null;
          maturity?: string | null;
          convertibility?: string | null;
          callable?: boolean;
          coupon_rate?: number | null;
          risk_factors?: string[];
          opens_at?: string | null;
          closes_at: string;
          pool_enabled?: boolean;
          status?: Database['public']['Enums']['content_status'];
          published_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          slug?: string;
          issuer_id?: string;
          title?: string;
          summary?: string | null;
          type_of_issue?: string;
          instruments?: string;
          no_of_instruments?: number | null;
          offer_price?: number | null;
          currency?: Database['public']['Enums']['currency_code'];
          lock_in?: string | null;
          maturity?: string | null;
          convertibility?: string | null;
          callable?: boolean;
          coupon_rate?: number | null;
          risk_factors?: string[];
          opens_at?: string | null;
          closes_at?: string;
          pool_enabled?: boolean;
          status?: Database['public']['Enums']['content_status'];
          published_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'roadshows_issuer_id_fkey';
            columns: ['issuer_id'];
            isOneToOne: false;
            referencedRelation: 'issuers';
            referencedColumns: ['id'];
          },
        ];
      };
      saved_items: {
        Row: {
          user_id: string;
          entity_type: Database['public']['Enums']['saved_entity_type'];
          entity_id: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          entity_type: Database['public']['Enums']['saved_entity_type'];
          entity_id: string;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          entity_type?: Database['public']['Enums']['saved_entity_type'];
          entity_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'saved_items_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
        ];
      };
      webinar_registrations: {
        Row: {
          webinar_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          webinar_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          webinar_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'webinar_registrations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['public_id'];
          },
          {
            foreignKeyName: 'webinar_registrations_webinar_id_fkey';
            columns: ['webinar_id'];
            isOneToOne: false;
            referencedRelation: 'webinars';
            referencedColumns: ['id'];
          },
        ];
      };
      webinars: {
        Row: {
          id: string;
          title: string;
          description: string | null;
          host_name: string | null;
          starts_at: string;
          ends_at: string;
          access: Database['public']['Enums']['content_access'];
          join_url: string | null;
          recording_url: string | null;
          observer_recording_at: string | null;
          status: Database['public']['Enums']['content_status'];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          host_name?: string | null;
          starts_at: string;
          ends_at: string;
          access?: Database['public']['Enums']['content_access'];
          join_url?: string | null;
          recording_url?: string | null;
          observer_recording_at?: string | null;
          status?: Database['public']['Enums']['content_status'];
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string | null;
          host_name?: string | null;
          starts_at?: string;
          ends_at?: string;
          access?: Database['public']['Enums']['content_access'];
          join_url?: string | null;
          recording_url?: string | null;
          observer_recording_at?: string | null;
          status?: Database['public']['Enums']['content_status'];
          created_at?: string;
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
      apply_credit_change: {
        Args: {
          p_user_id: string;
          p_delta: number;
          p_reason: Database['public']['Enums']['credit_reason'];
          p_ref_type?: string;
          p_ref_id?: string;
          p_note?: string;
        };
        Returns: Database['public']['Tables']['credit_ledger']['Row'][];
        SetofOptions: {
          from: '*';
          to: 'credit_ledger';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      join_roadshow_pool: {
        Args: {
          p_user_id: string;
          p_roadshow_id: string;
          p_capital_interest: number;
          p_expectations: Database['public']['Enums']['pool_expectation'][];
          p_idempotency_key: string;
          p_request_hash: string;
        };
        Returns: {
          joined_at: string;
          credits_remaining: number;
        }[];
      };
      roadshow_pool_power: {
        Args: { p_roadshow_id: string };
        Returns: {
          band: number;
          band_min: number;
          band_max: number;
          band_members: number;
          band_capital: number;
          expectation: Database['public']['Enums']['pool_expectation'];
          votes: number;
        }[];
      };
    };
    Enums: {
      asset_class: 'EQ' | 'MF' | 'INS' | 'BND' | 'PMS' | 'BRK' | 'RE' | 'CRY';
      display_mode: 'FULL_NAME' | 'INITIALS' | 'ANONYMOUS';
      investment_status: 'CURRENTLY_INVESTED' | 'EXITED' | 'NEVER_INVESTED';
      market_country: 'IN' | 'AE' | 'OTHER';
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
      content_access: 'FREE' | 'PREMIUM';
      content_status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      credit_reason: 'ADMIN_GRANT' | 'ADMIN_REVOKE' | 'PURCHASE' | 'REFUND' | 'POOL_JOIN';
      currency_code: 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED';
      device_platform: 'IOS' | 'ANDROID' | 'WEB';
      learn_format: 'VIDEO' | 'ARTICLE' | 'REPORT' | 'PODCAST';
      notification_type:
        | 'SYSTEM'
        | 'CREDITS'
        | 'POOL'
        | 'ROADSHOW'
        | 'WEBINAR'
        | 'REVIEW'
        | 'LEARN'
        | 'KYC'
        | 'RATING'
        | 'REPRESENTATION';
      offer_status: 'PENDING_REVIEW' | 'PUBLISHED' | 'WITHDRAWN' | 'REJECTED';
      pool_expectation:
        | 'BETTER_ROI_IRR'
        | 'SHORTER_LOCK_IN'
        | 'LOWER_ENTRY_LOAD'
        | 'LOWER_EXIT_LOAD'
        | 'PRIORITY_ALLOTMENT'
        | 'FLEXIBLE_PAYMENT_TERMS'
        | 'DISCOUNTED_OFFER_PRICE'
        | 'REGULAR_DISCLOSURES';
      question_category: 'GENERAL' | 'EQUITY' | 'DEBT' | 'INSURANCE' | 'CRYPTO' | 'MUTUAL_FUNDS';
      question_status: 'PENDING_MODERATION' | 'PUBLISHED' | 'REJECTED';
      saved_entity_type: 'COMPANY' | 'ISSUER' | 'ROADSHOW' | 'LEARN_ITEM';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type Views<T extends keyof PublicSchema['Views']> = PublicSchema['Views'][T]['Row'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];

/** Enum values as runtime tuples, for zod schemas. `satisfies` keeps them in sync with the types. */
export const Constants = {
  public: {
    Enums: {
      asset_class: ['EQ', 'MF', 'INS', 'BND', 'PMS', 'BRK', 'RE', 'CRY'],
      display_mode: ['FULL_NAME', 'INITIALS', 'ANONYMOUS'],
      investment_status: ['CURRENTLY_INVESTED', 'EXITED', 'NEVER_INVESTED'],
      market_country: ['IN', 'AE', 'OTHER'],
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
      content_access: ['FREE', 'PREMIUM'],
      content_status: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
      credit_reason: ['ADMIN_GRANT', 'ADMIN_REVOKE', 'PURCHASE', 'REFUND', 'POOL_JOIN'],
      currency_code: ['INR', 'USD', 'EUR', 'GBP', 'AED'],
      device_platform: ['IOS', 'ANDROID', 'WEB'],
      learn_format: ['VIDEO', 'ARTICLE', 'REPORT', 'PODCAST'],
      notification_type: [
        'SYSTEM',
        'CREDITS',
        'POOL',
        'ROADSHOW',
        'WEBINAR',
        'REVIEW',
        'LEARN',
        'KYC',
        'RATING',
        'REPRESENTATION',
      ],
      offer_status: ['PENDING_REVIEW', 'PUBLISHED', 'WITHDRAWN', 'REJECTED'],
      pool_expectation: [
        'BETTER_ROI_IRR',
        'SHORTER_LOCK_IN',
        'LOWER_ENTRY_LOAD',
        'LOWER_EXIT_LOAD',
        'PRIORITY_ALLOTMENT',
        'FLEXIBLE_PAYMENT_TERMS',
        'DISCOUNTED_OFFER_PRICE',
        'REGULAR_DISCLOSURES',
      ],
      question_category: ['GENERAL', 'EQUITY', 'DEBT', 'INSURANCE', 'CRYPTO', 'MUTUAL_FUNDS'],
      question_status: ['PENDING_MODERATION', 'PUBLISHED', 'REJECTED'],
      saved_entity_type: ['COMPANY', 'ISSUER', 'ROADSHOW', 'LEARN_ITEM'],
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
