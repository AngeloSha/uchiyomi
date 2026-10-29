"""Boundary checks for the optional, review-only cover extraction trial."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('extract_cover', Path(__file__).with_name('extract-cover.py'))
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class CoverExtractionTest(unittest.TestCase):
    def test_invalid_regions_are_refused(self):
        for region in (None, [], [0, 0, 1], [-.1, 0, 1, 1], [0, 0, 2, 1], [0, .5, 1, .5],
                       [0, 0, float('nan'), 1], [False, 0, 1, 1], [0, 0, .00001, .00001]):
            with self.subTest(region=region), self.assertRaises(ValueError):
                trial.region_box(region, 600, 900)
        self.assertEqual(trial.region_box([.1, .2, .9, .8], 600, 900), [60, 180, 540, 720])

    def test_background_is_transparent_and_letter_colours_are_unchanged(self):
        rgb = np.full((50, 90, 3), [45, 99, 144], dtype=np.uint8)
        mask = np.zeros((50, 90), dtype=bool)
        mask[8:32, 10:22] = True
        mask[16:24, 22:62] = True
        rgba = np.asarray(trial.cutout(rgb, mask, [0, 0, 90, 50]))
        self.assertEqual(set(np.unique(rgba[:, :, 3])), {0, 255})
        self.assertTrue(np.all(rgba[rgba[:, :, 3] == 255][:, :3] == [45, 99, 144]))
        with self.assertRaises(ValueError):
            trial.cutout(rgb, np.zeros_like(mask), [0, 0, 90, 50])

    def test_blank_cover_has_no_candidate_and_small_specks_do_not_win(self):
        mask = np.zeros((600, 400), dtype=bool)
        self.assertEqual(trial.text_regions(mask), [])
        mask[50:90, 30:70] = True
        mask[50:90, 75:130] = True
        mask[50:90, 135:220] = True
        mask[300:302, 150:152] = True
        regions = trial.text_regions(mask)
        self.assertEqual(len(regions), 1)
        self.assertLess(regions[0]['box'][1], 60)
        self.assertGreater(regions[0]['box'][2], 210)


if __name__ == '__main__':
    unittest.main()
