from pathlib import Path
import unittest
import numpy as np
from stroke_completion import complete_dark_strokes


class StrokeCompletionTest(unittest.TestCase):
    def fixture(self):
        rgb = np.full((160, 160, 3), [150, 105, 75], dtype=np.uint8)
        seed = np.zeros((160, 160), dtype=bool)
        seed[50:90, 65:80] = True
        rgb[seed] = [255, 220, 150]
        # A connected, small dark letter edge with a tip below the existing gold.
        rgb[51:94, 80:82] = [18, 13, 8]
        support = np.zeros_like(seed)
        support[51:94, 80:82] = True
        return rgb, seed, support

    def test_recovers_model_supported_dark_tip_preserving_gold_and_source_rgb(self):
        rgb, seed, support = self.fixture()
        source, original = rgb.copy(), seed.copy()
        changed = complete_dark_strokes(rgb, seed, support, [30, 30, 120, 120])
        self.assertTrue(changed[92, 80], 'a real supported dark stroke may extend past the bright core')
        self.assertTrue(np.all(changed[seed]))
        self.assertFalse(changed[93, 83], 'nearby brown cover must remain transparent')
        self.assertTrue(np.array_equal(rgb, source)); self.assertTrue(np.array_equal(seed, original))

    def test_brown_background_or_unsupported_darkness_is_never_a_color_only_dilation(self):
        rgb, seed, support = self.fixture()
        self.assertTrue(np.array_equal(complete_dark_strokes(rgb, seed, np.zeros_like(support), [0, 0, 160, 160]), seed))
        rgb[51:94, 80:82] = [135, 90, 50]
        self.assertTrue(np.array_equal(complete_dark_strokes(rgb, seed, support, [0, 0, 160, 160]), seed))

    def test_connected_dark_background_cannot_be_clipped_into_a_plausible_little_outline(self):
        rgb, seed, support = self.fixture()
        # This makes the little tip part of a much larger background component all the way to the edge.
        rgb[93, 81:160] = [18, 13, 8]
        changed = complete_dark_strokes(rgb, seed, support, [30, 30, 120, 120])
        self.assertTrue(np.array_equal(changed, seed), 'measure whole-source components before model/distance/ROI clipping')

    def test_component_crossing_requested_region_is_rejected_as_a_whole(self):
        rgb, seed, support = self.fixture()
        changed = complete_dark_strokes(rgb, seed, support, [30, 30, 120, 91])
        self.assertTrue(np.array_equal(changed, seed))

    def test_dark_titles_and_separate_dark_objects_do_not_expand(self):
        rgb, seed, support = self.fixture()
        rgb[seed] = [30, 20, 15]
        self.assertTrue(np.array_equal(complete_dark_strokes(rgb, seed, support, [0, 0, 160, 160]), seed))
        rgb, seed, support = self.fixture(); rgb[51:94, 80:82] = [150, 105, 75]
        rgb[51:80, 87:89] = [18, 13, 8];support[51:80, 87:89] = True
        self.assertTrue(np.array_equal(complete_dark_strokes(rgb, seed, support, [0, 0, 160, 160]), seed))

    def test_small_model_supported_slice_cannot_hide_a_large_unsupported_component(self):
        rgb, seed, support = self.fixture()
        support[:] = False; support[92, 80] = True
        self.assertTrue(np.array_equal(complete_dark_strokes(rgb, seed, support, [0, 0, 160, 160]), seed))

    def test_enclosed_transparent_font_counters_never_become_dark_lettering(self):
        rgb, seed, support = self.fixture()
        # A clear transparent counter inside the existing bright letter, with dark cover behind it.
        seed[66:71, 70:74] = False
        rgb[66:71, 70:74] = [18, 13, 8]
        support[66:71, 70:74] = True
        changed = complete_dark_strokes(rgb, seed, support, [0, 0, 160, 160])
        self.assertFalse(changed[66:71, 70:74].any(), 'weak text-model support does not turn cover inside a font hole into ink')
        self.assertTrue(changed[92, 80], 'exterior dark lettering can still be recovered')
        self.assertTrue(np.all(changed[seed]))

    def test_invalid_geometry_and_non_raster_input_fail_closed(self):
        rgb, seed, support = self.fixture()
        for invalid in [[-1, 0, 160, 160], [0, 0, 161, 160], [0, 0, True, 160]]:
            with self.assertRaises(ValueError): complete_dark_strokes(rgb, seed, support, invalid)
        with self.assertRaises(ValueError): complete_dark_strokes(rgb.astype(float), seed, support, [0, 0, 160, 160])
        with self.assertRaises(ValueError): complete_dark_strokes(rgb, seed.astype(np.uint8), support, [0, 0, 160, 160])
        with self.assertRaises(ValueError): complete_dark_strokes(rgb, seed, support[:-1], [0, 0, 160, 160])

    def test_build_context_and_docker_copy_the_new_runtime_dependency(self):
        service = Path(__file__).resolve().parent
        self.assertIn('stroke_completion.py', (service / 'Dockerfile').read_text())
        self.assertIn('stroke_completion.py', (service.parents[1] / 'scripts/title-art/build-worker.py').read_text())

if __name__ == '__main__': unittest.main()
