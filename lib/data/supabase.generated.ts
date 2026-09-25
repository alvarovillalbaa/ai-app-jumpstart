// Generated from the migrated local Supabase schema by npm run db:types. Do not edit.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      app_artifacts: {
        Row: {
          call_id: string
          content: string
          created_at: number
          deleted_at: number | null
          id: string
          input_hash: string
          operation_id: string
          session_id: string
          title: string
        }
        Insert: {
          call_id: string
          content: string
          created_at: number
          deleted_at?: number | null
          id: string
          input_hash: string
          operation_id: string
          session_id: string
          title: string
        }
        Update: {
          call_id?: string
          content?: string
          created_at?: number
          deleted_at?: number | null
          id?: string
          input_hash?: string
          operation_id?: string
          session_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_artifacts_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "app_conversations"
            referencedColumns: ["operation_id"]
          },
        ]
      }
      app_budget_accounts: {
        Row: {
          subject: string
          tenant: string
        }
        Insert: {
          subject: string
          tenant: string
        }
        Update: {
          subject?: string
          tenant?: string
        }
        Relationships: []
      }
      app_budget_attempts: {
        Row: {
          attempt_id: string
          operation_id: string
        }
        Insert: {
          attempt_id: string
          operation_id: string
        }
        Update: {
          attempt_id?: string
          operation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_budget_attempts_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "app_budget_reservations"
            referencedColumns: ["operation_id"]
          },
        ]
      }
      app_budget_corrections: {
        Row: {
          actor: string
          at: number
          corrected_actual_micros: number
          correction_id: string
          evidence_ref: string
          operation_id: string
          previous_actual_micros: number | null
          reason: string
          subject: string
          tenant: string
        }
        Insert: {
          actor: string
          at: number
          corrected_actual_micros: number
          correction_id: string
          evidence_ref: string
          operation_id: string
          previous_actual_micros?: number | null
          reason: string
          subject: string
          tenant: string
        }
        Update: {
          actor?: string
          at?: number
          corrected_actual_micros?: number
          correction_id?: string
          evidence_ref?: string
          operation_id?: string
          previous_actual_micros?: number | null
          reason?: string
          subject?: string
          tenant?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_budget_corrections_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "app_budget_reservations"
            referencedColumns: ["operation_id"]
          },
        ]
      }
      app_budget_reservations: {
        Row: {
          actual_micros: number | null
          created_at: number
          day: number
          estimate_micros: number
          operation_id: string
          policy_id: string
          request_hash: string
          status: string
          subject: string
          tenant: string
        }
        Insert: {
          actual_micros?: number | null
          created_at: number
          day: number
          estimate_micros: number
          operation_id: string
          policy_id: string
          request_hash: string
          status: string
          subject: string
          tenant: string
        }
        Update: {
          actual_micros?: number | null
          created_at?: number
          day?: number
          estimate_micros?: number
          operation_id?: string
          policy_id?: string
          request_hash?: string
          status?: string
          subject?: string
          tenant?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_budget_reservations_tenant_subject_fkey"
            columns: ["tenant", "subject"]
            isOneToOne: false
            referencedRelation: "app_budget_accounts"
            referencedColumns: ["tenant", "subject"]
          },
        ]
      }
      app_conversation_events: {
        Row: {
          event_id: string
          operation_id: string
          ordinal: number
          payload: string
          source_index: number | null
        }
        Insert: {
          event_id: string
          operation_id: string
          ordinal?: never
          payload: string
          source_index?: number | null
        }
        Update: {
          event_id?: string
          operation_id?: string
          ordinal?: never
          payload?: string
          source_index?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "app_conversation_events_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "app_conversations"
            referencedColumns: ["operation_id"]
          },
        ]
      }
      app_conversations: {
        Row: {
          archived: number
          created_at: number
          id: string
          operation_id: string
          request_hash: string
          revision: number
          session_id: string | null
          status: string
          subject: string
          tenant: string
          title: string
        }
        Insert: {
          archived?: number
          created_at?: number
          id: string
          operation_id: string
          request_hash: string
          revision?: number
          session_id?: string | null
          status: string
          subject: string
          tenant: string
          title?: string
        }
        Update: {
          archived?: number
          created_at?: number
          id?: string
          operation_id?: string
          request_hash?: string
          revision?: number
          session_id?: string | null
          status?: string
          subject?: string
          tenant?: string
          title?: string
        }
        Relationships: []
      }
      app_internal_nonces: {
        Row: {
          expires_at: number
          id: string
        }
        Insert: {
          expires_at: number
          id: string
        }
        Update: {
          expires_at?: number
          id?: string
        }
        Relationships: []
      }
      app_migrations: {
        Row: {
          applied_at: string
          name: string
        }
        Insert: {
          applied_at?: string
          name: string
        }
        Update: {
          applied_at?: string
          name?: string
        }
        Relationships: []
      }
      app_records: {
        Row: {
          content: string
          created_at: string
          id: string
          revision: number
          subject: string
          tenant: string
          title: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          id: string
          revision?: number
          subject: string
          tenant: string
          title: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          revision?: number
          subject?: string
          tenant?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_uploads: {
        Row: {
          created_at: number
          id: string
          media_type: string
          name: string
          sha256: string
          size: number
          state: string
          subject: string
          tenant: string
        }
        Insert: {
          created_at: number
          id: string
          media_type: string
          name: string
          sha256: string
          size: number
          state: string
          subject: string
          tenant: string
        }
        Update: {
          created_at?: number
          id?: string
          media_type?: string
          name?: string
          sha256?: string
          size?: number
          state?: string
          subject?: string
          tenant?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      app_append_conversation_event: {
        Args: {
          p_event: string
          p_operation: string
          p_payload: string
          p_session: string
          p_source_index?: number
          p_subject: string
          p_tenant: string
        }
        Returns: string
      }
      app_budget_attempt_command: {
        Args: { command: string; input: Json }
        Returns: Json
      }
      app_budget_command: {
        Args: { command: string; input: Json }
        Returns: Json
      }
      app_budget_correct_settlement: { Args: { input: Json }; Returns: string }
      app_delete_artifact: {
        Args: {
          p_deleted: number
          p_id: string
          p_subject: string
          p_tenant: string
        }
        Returns: boolean
      }
      app_save_artifact: {
        Args: {
          p_call: string
          p_content: string
          p_created: number
          p_hash: string
          p_id: string
          p_operation: string
          p_session: string
          p_subject: string
          p_tenant: string
          p_title: string
        }
        Returns: Json
      }
      app_upload_command: {
        Args: { command: string; input: Json }
        Returns: Json
      }
      app_upload_list: { Args: { input: Json }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
