<?php
/**
 * Plugin Name: Mynt Set iCal Feeds
 * Description: REST endpoints to manage iCal feeds and expose WP blocked dates
 * Version: 1.9
 */

add_action('rest_api_init', function () {

    register_rest_route('mynt/v1', '/property/(?P<id>\d+)/ical-feed', [
        'methods'             => 'POST',
        'callback'            => 'mynt_set_ical_feed',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
        'args' => [
            'id'  => ['validate_callback' => fn($v) => is_numeric($v)],
            'url' => ['required' => true],
        ],
    ]);

    register_rest_route('mynt/v1', '/property/(?P<id>\d+)/ical-feed', [
        'methods'             => 'GET',
        'callback'            => 'mynt_get_ical_feed',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
    ]);

    register_rest_route('mynt/v1', '/export-urls', [
        'methods'             => 'GET',
        'callback'            => 'mynt_get_export_urls',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
    ]);

    // Used by sync-blocks.js — returns all WP bookings/blocks
    register_rest_route('mynt/v1', '/wp-blocked', [
        'methods'             => 'GET',
        'callback'            => 'mynt_get_wp_blocked',
        'permission_callback' => '__return_true',
    ]);

    // Called by GitHub Actions after each sync — forces WP Rentals to re-import all iCal feeds now
    register_rest_route('mynt/v1', '/trigger-ical-import', [
        'methods'             => 'POST',
        'callback'            => 'mynt_trigger_ical_import',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
    ]);
});

function mynt_set_ical_feed(WP_REST_Request $req) {
    $post_id = (int) $req['id'];
    if (get_post_status($post_id) === false) {
        return new WP_Error('not_found', "post $post_id not found", ['status' => 404]);
    }
    $url = esc_url_raw(trim((string) $req['url']));
    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        return new WP_Error('bad_url', 'url is not valid', ['status' => 400]);
    }
    $feeds = [['name' => 'Kixedo', 'feed' => $url]];
    update_post_meta($post_id, 'property_icalendar_import_multi', $feeds);
    wp_cache_delete($post_id, 'post_meta');
    return ['post_id' => $post_id, 'feed' => $url, 'status' => 'ok'];
}

function mynt_get_ical_feed(WP_REST_Request $req) {
    $post_id = (int) $req['id'];
    $raw = get_post_meta($post_id, 'property_icalendar_import_multi', true);
    $feeds = is_array($raw) ? $raw : [];
    return ['post_id' => $post_id, 'feeds' => $feeds];
}

function mynt_get_export_urls() {
    global $wpdb;
    $meta_key = 'unique_code_ica';
    $site_url  = get_site_url();
    $all_props = $wpdb->get_col("
        SELECT ID FROM {$wpdb->posts}
        WHERE post_type = 'estate_property'
          AND post_status NOT IN ('trash','auto-draft')
    ");
    $out = [];
    foreach ($all_props as $post_id) {
        $token = get_post_meta($post_id, $meta_key, true);
        if (!$token) {
            $token = md5(uniqid(rand(), true));
            update_post_meta($post_id, $meta_key, $token);
        }
        $out[] = ['wp_post_id' => (int) $post_id, 'token' => $token, 'export_url' => $site_url . '/?ical=' . $token];
    }
    return rest_ensure_response(['count' => count($out), 'properties' => $out]);
}

function mynt_trigger_ical_import() {
    global $wpdb;

    // Get all estate_property post IDs that have an iCal import feed set
    $props = $wpdb->get_col("
        SELECT DISTINCT post_id FROM {$wpdb->postmeta}
        WHERE meta_key = 'property_icalendar_import_multi'
          AND meta_value != ''
          AND meta_value != 'a:0:{}'
    ");

    $triggered = 0;
    foreach ($props as $post_id) {
        $feeds = get_post_meta($post_id, 'property_icalendar_import_multi', true);
        if (!is_array($feeds) || empty($feeds)) continue;

        foreach ($feeds as $feed) {
            $url = isset($feed['feed']) ? $feed['feed'] : '';
            if (!$url) continue;

            // Fetch the iCal feed
            $response = wp_remote_get($url, ['timeout' => 15, 'sslverify' => false]);
            if (is_wp_error($response)) continue;

            $body = wp_remote_retrieve_body($response);
            if (empty($body) || strpos($body, 'BEGIN:VCALENDAR') === false) continue;

            // Let WP Rentals process it if the function exists
            if (function_exists('wpestate_import_ical_data')) {
                wpestate_import_ical_data($post_id, $body);
                $triggered++;
            } elseif (function_exists('wprentals_import_ical_data')) {
                wprentals_import_ical_data($post_id, $body);
                $triggered++;
            } else {
                // Fallback: fire the WP Rentals cron action directly
                do_action('wpestate_ical_cron');
                return rest_ensure_response(['triggered' => 'cron_action', 'props' => count($props)]);
            }
        }
    }

    return rest_ensure_response(['triggered' => $triggered, 'props' => count($props)]);
}

function mynt_get_wp_blocked() {
    global $wpdb;

    // Correct meta keys discovered from DB inspection:
    // booking_id         = WP property post ID
    // booking_from_date  = start date in YY-MM-DD format
    // booking_to_date    = end date in YY-MM-DD format
    // booking_status     = confirmed / pending / owner_block etc (stored as meta, not post_status)

    $results = $wpdb->get_results("
        SELECT
            p.ID AS booking_id,
            p.post_status,
            MAX(CASE WHEN pm.meta_key = 'booking_id'        THEN pm.meta_value END) AS property_id,
            MAX(CASE WHEN pm.meta_key = 'booking_from_date' THEN pm.meta_value END) AS from_date,
            MAX(CASE WHEN pm.meta_key = 'booking_to_date'   THEN pm.meta_value END) AS to_date,
            MAX(CASE WHEN pm.meta_key = 'booking_status'    THEN pm.meta_value END) AS booking_status
        FROM {$wpdb->posts} p
        LEFT JOIN {$wpdb->postmeta} pm ON pm.post_id = p.ID
        WHERE p.post_type   = 'wpestate_booking'
          AND p.post_status NOT IN ('trash', 'auto-draft')
        GROUP BY p.ID
        HAVING property_id IS NOT NULL AND from_date IS NOT NULL AND to_date IS NOT NULL
        ORDER BY from_date
    ");

    $out = [];
    foreach ($results as $r) {
        // Convert YY-MM-DD → YYYY-MM-DD
        $start = '20' . $r->from_date;
        $end   = '20' . $r->to_date;

        $out[] = [
            'wp_post_id'      => (int) $r->property_id,
            'start'           => $start,
            'end'             => $end,
            'summary'         => 'BLOCKED',
            '_booking_status' => $r->booking_status,
            '_post_status'    => $r->post_status,
        ];
    }
    return rest_ensure_response($out);
}
