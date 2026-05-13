<?php
/**
 * Plugin Name: Mynt Set iCal Feeds
 * Description: REST endpoint to wire Netlify iCal feeds into each property on bluekeys.co
 * Version: 1.0
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

    // WP Rentals expects: array of [ 'name' => string, 'feed' => string ]
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
