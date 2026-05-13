<?php
/**
 * Plugin Name: Mynt Blocked Dates API
 * Description: Exposes manually blocked dates for iCal sync
 * Version: 1.0
 */

add_action('rest_api_init', function () {
    register_rest_route('mynt/v1', '/blocked', [
        'methods'             => 'GET',
        'callback'            => 'mynt_get_blocked_dates',
        'permission_callback' => '__return_true',
    ]);
});

function mynt_get_blocked_dates() {
    global $wpdb;

    // Query WP Rentals booking table for owner blocks / unavailable dates
    $results = $wpdb->get_results("
        SELECT DISTINCT
            pm_prop.meta_value  AS property_id,
            pm_start.meta_value AS start_date,
            pm_end.meta_value   AS end_date
        FROM {$wpdb->posts} p
        JOIN {$wpdb->postmeta} pm_prop  ON pm_prop.post_id  = p.ID AND pm_prop.meta_key  = 'booking_property'
        JOIN {$wpdb->postmeta} pm_start ON pm_start.post_id = p.ID AND pm_start.meta_key = 'booking_start_date'
        JOIN {$wpdb->postmeta} pm_end   ON pm_end.post_id   = p.ID AND pm_end.meta_key   = 'booking_end_date'
        WHERE p.post_type   = 'wpestate_booking'
          AND p.post_status IN ('confirmed','owner_block','blocked','publish')
        ORDER BY pm_start.meta_value
    ");

    if (empty($results)) {
        // Fallback: read from _mynt_manual_blocks post meta on each property
        $blocks = $wpdb->get_results("
            SELECT post_id, meta_value
            FROM {$wpdb->postmeta}
            WHERE meta_key = '_mynt_manual_blocks'
              AND meta_value != ''
        ");

        $out = [];
        foreach ($blocks as $row) {
            $kixedo_id = get_post_meta($row->post_id, '_kixedo_id', true);
            if (!$kixedo_id) continue;
            $entries = json_decode($row->meta_value, true) ?: [];
            foreach ($entries as $e) {
                $e['wp_post_id'] = (int) $row->post_id;
                $e['kixedo_id']  = (int) $kixedo_id;
                $out[] = $e;
            }
        }
        return rest_ensure_response($out);
    }

    $out = [];
    foreach ($results as $r) {
        $out[] = [
            'wp_post_id' => (int) $r->property_id,
            'start'      => $r->start_date,
            'end'        => $r->end_date,
            'summary'    => 'BLOCKED',
        ];
    }
    return rest_ensure_response($out);
}
