export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      event_dates: {
        Row: {
          created_at: string
          doors_at: string | null
          event_id: string
          id: string
          on_sale: boolean
          starts_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          doors_at?: string | null
          event_id: string
          id?: string
          on_sale?: boolean
          starts_at: string
          venue_id: string
        }
        Update: {
          created_at?: string
          doors_at?: string | null
          event_id?: string
          id?: string
          on_sale?: boolean
          starts_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_dates_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_dates_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      event_metrics: {
        Row: {
          amount: number
          created_at: string
          event_id: string
          id: string
          kind: Database["public"]["Enums"]["metric_kind"]
          quantity: number
        }
        Insert: {
          amount?: number
          created_at?: string
          event_id: string
          id?: string
          kind: Database["public"]["Enums"]["metric_kind"]
          quantity?: number
        }
        Update: {
          amount?: number
          created_at?: string
          event_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["metric_kind"]
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "event_metrics_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          age_restriction: string | null
          artist: string | null
          category: Database["public"]["Enums"]["event_category"]
          created_at: string
          description: string | null
          featured: boolean
          id: string
          image_url: string | null
          slug: string
          status: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at: string
          urgency_note: string | null
        }
        Insert: {
          age_restriction?: string | null
          artist?: string | null
          category?: Database["public"]["Enums"]["event_category"]
          created_at?: string
          description?: string | null
          featured?: boolean
          id?: string
          image_url?: string | null
          slug: string
          status?: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at?: string
          urgency_note?: string | null
        }
        Update: {
          age_restriction?: string | null
          artist?: string | null
          category?: Database["public"]["Enums"]["event_category"]
          created_at?: string
          description?: string | null
          featured?: boolean
          id?: string
          image_url?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["event_status"]
          title?: string
          updated_at?: string
          urgency_note?: string | null
        }
        Relationships: []
      }
      newsletter_subscribers: {
        Row: {
          created_at: string
          email: string
          id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
        }
        Relationships: []
      }
      order_items: {
        Row: {
          created_at: string
          event_date_id: string
          id: string
          order_id: string
          quantity: number
          seat_id: string | null
          ticket_type_id: string
          unit_fee: number
          unit_price: number
        }
        Insert: {
          created_at?: string
          event_date_id: string
          id?: string
          order_id: string
          quantity?: number
          seat_id?: string | null
          ticket_type_id: string
          unit_fee?: number
          unit_price: number
        }
        Update: {
          created_at?: string
          event_date_id?: string
          id?: string
          order_id?: string
          quantity?: number
          seat_id?: string | null
          ticket_type_id?: string
          unit_fee?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_event_date_id_fkey"
            columns: ["event_date_id"]
            isOneToOne: false
            referencedRelation: "event_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "venue_seats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_ticket_type_id_fkey"
            columns: ["ticket_type_id"]
            isOneToOne: false
            referencedRelation: "ticket_types"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          buyer_document: string | null
          buyer_email: string
          buyer_name: string
          buyer_phone: string | null
          created_at: string
          discount: number
          fees: number
          id: string
          order_code: string
          promo_code: string | null
          status: Database["public"]["Enums"]["order_status"]
          subtotal: number
          total: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          buyer_document?: string | null
          buyer_email: string
          buyer_name: string
          buyer_phone?: string | null
          created_at?: string
          discount?: number
          fees?: number
          id?: string
          order_code: string
          promo_code?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          subtotal?: number
          total?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          buyer_document?: string | null
          buyer_email?: string
          buyer_name?: string
          buyer_phone?: string | null
          created_at?: string
          discount?: number
          fees?: number
          id?: string
          order_code?: string
          promo_code?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          subtotal?: number
          total?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      promo_codes: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          max_uses: number
          percent_off: number
          used_count: number
          valid_until: string | null
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          max_uses?: number
          percent_off?: number
          used_count?: number
          valid_until?: string | null
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          max_uses?: number
          percent_off?: number
          used_count?: number
          valid_until?: string | null
        }
        Relationships: []
      }
      queue_config: {
        Row: {
          concurrent_slots: number
          created_at: string
          enabled: boolean
          event_id: string
          id: string
          simulated_queue_size: number
          updated_at: string
          waiting_message: string | null
          window_minutes: number
        }
        Insert: {
          concurrent_slots?: number
          created_at?: string
          enabled?: boolean
          event_id: string
          id?: string
          simulated_queue_size?: number
          updated_at?: string
          waiting_message?: string | null
          window_minutes?: number
        }
        Update: {
          concurrent_slots?: number
          created_at?: string
          enabled?: boolean
          event_id?: string
          id?: string
          simulated_queue_size?: number
          updated_at?: string
          waiting_message?: string | null
          window_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "queue_config_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: true
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      queue_sessions: {
        Row: {
          activated_at: string | null
          entered_at: string
          event_id: string
          expires_at: string | null
          id: string
          position: number
          session_token: string
          state: Database["public"]["Enums"]["queue_state"]
        }
        Insert: {
          activated_at?: string | null
          entered_at?: string
          event_id: string
          expires_at?: string | null
          id?: string
          position?: number
          session_token: string
          state?: Database["public"]["Enums"]["queue_state"]
        }
        Update: {
          activated_at?: string | null
          entered_at?: string
          event_id?: string
          expires_at?: string | null
          id?: string
          position?: number
          session_token?: string
          state?: Database["public"]["Enums"]["queue_state"]
        }
        Relationships: [
          {
            foreignKeyName: "queue_sessions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      seat_holds: {
        Row: {
          created_at: string
          event_date_id: string
          expires_at: string
          id: string
          seat_id: string
          session_token: string
          sold: boolean
        }
        Insert: {
          created_at?: string
          event_date_id: string
          expires_at: string
          id?: string
          seat_id: string
          session_token: string
          sold?: boolean
        }
        Update: {
          created_at?: string
          event_date_id?: string
          expires_at?: string
          id?: string
          seat_id?: string
          session_token?: string
          sold?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "seat_holds_event_date_id_fkey"
            columns: ["event_date_id"]
            isOneToOne: false
            referencedRelation: "event_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_holds_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "venue_seats"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_types: {
        Row: {
          capacity: number
          created_at: string
          event_date_id: string
          id: string
          name: string
          price: number
          section_id: string
          service_fee: number
          sold: number
        }
        Insert: {
          capacity?: number
          created_at?: string
          event_date_id: string
          id?: string
          name: string
          price: number
          section_id: string
          service_fee?: number
          sold?: number
        }
        Update: {
          capacity?: number
          created_at?: string
          event_date_id?: string
          id?: string
          name?: string
          price?: number
          section_id?: string
          service_fee?: number
          sold?: number
        }
        Relationships: [
          {
            foreignKeyName: "ticket_types_event_date_id_fkey"
            columns: ["event_date_id"]
            isOneToOne: false
            referencedRelation: "event_dates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_types_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "venue_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          attendee_name: string | null
          checked_in_at: string | null
          created_at: string
          id: string
          order_id: string
          order_item_id: string
          ticket_code: string
        }
        Insert: {
          attendee_name?: string | null
          checked_in_at?: string | null
          created_at?: string
          id?: string
          order_id: string
          order_item_id: string
          ticket_code: string
        }
        Update: {
          attendee_name?: string | null
          checked_in_at?: string | null
          created_at?: string
          id?: string
          order_id?: string
          order_item_id?: string
          ticket_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      venue_seats: {
        Row: {
          blocked: boolean
          id: string
          row_label: string
          seat_number: number
          section_id: string
          x: number
          y: number
        }
        Insert: {
          blocked?: boolean
          id?: string
          row_label: string
          seat_number: number
          section_id: string
          x: number
          y: number
        }
        Update: {
          blocked?: boolean
          id?: string
          row_label?: string
          seat_number?: number
          section_id?: string
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "venue_seats_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "venue_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_sections: {
        Row: {
          capacity: number
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["section_kind"]
          name: string
          shape_h: number
          shape_w: number
          shape_x: number
          shape_y: number
          sort_order: number
          venue_id: string
        }
        Insert: {
          capacity?: number
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["section_kind"]
          name: string
          shape_h?: number
          shape_w?: number
          shape_x?: number
          shape_y?: number
          sort_order?: number
          venue_id: string
        }
        Update: {
          capacity?: number
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["section_kind"]
          name?: string
          shape_h?: number
          shape_w?: number
          shape_x?: number
          shape_y?: number
          sort_order?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_sections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string | null
          capacity: number
          city: string
          created_at: string
          id: string
          map_height: number
          map_width: number
          name: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          capacity?: number
          city: string
          created_at?: string
          id?: string
          map_height?: number
          map_width?: number
          name: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          capacity?: number
          city?: string
          created_at?: string
          id?: string
          map_height?: number
          map_width?: number
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin"
      event_category:
        | "conciertos"
        | "teatro"
        | "festivales"
        | "deportes"
        | "familia"
      event_status: "draft" | "published" | "soldout" | "archived"
      metric_kind: "view" | "add_to_cart" | "checkout" | "purchase"
      order_status: "pending" | "paid" | "refunded" | "cancelled"
      queue_state: "waiting" | "active" | "expired" | "done"
      section_kind: "seated" | "general"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin"],
      event_category: [
        "conciertos",
        "teatro",
        "festivales",
        "deportes",
        "familia",
      ],
      event_status: ["draft", "published", "soldout", "archived"],
      metric_kind: ["view", "add_to_cart", "checkout", "purchase"],
      order_status: ["pending", "paid", "refunded", "cancelled"],
      queue_state: ["waiting", "active", "expired", "done"],
      section_kind: ["seated", "general"],
    },
  },
} as const
