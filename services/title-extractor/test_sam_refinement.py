from contextlib import nullcontext
from types import SimpleNamespace
import unittest

import numpy as np

from sam_refinement import SamRefiner, select_refinement


class CandidateSelectionTest(unittest.TestCase):
    def setUp(self):
        self.seed = np.zeros((30, 50), dtype=bool)
        self.seed[10:15, 10:20] = True
        self.box = [5, 5, 35, 25]

    def candidate(self, left, top, right, bottom):
        mask = np.zeros_like(self.seed)
        mask[top:bottom, left:right] = True
        return mask

    def test_smallest_valid_mask_wins_without_any_score(self):
        small = self.candidate(10, 9, 20, 16)
        larger = self.candidate(9, 8, 22, 18)
        chosen = select_refinement(self.seed, [larger, small], self.box)
        np.testing.assert_array_equal(chosen, small)
        chosen[0, 0] = True
        self.assertFalse(small[0, 0], 'selection must not mutate model output')

    def test_background_blocks_leaks_and_seed_loss_fail_closed(self):
        whole_crop = np.ones_like(self.seed)
        dense_box = self.candidate(5, 5, 35, 25)
        leaked = self.candidate(10, 9, 20, 16); leaked[0, 0] = True
        partial = self.seed.copy(); partial[10:12] = False
        huge = self.candidate(5, 5, 30, 20)
        self.assertIsNone(select_refinement(self.seed, [whole_crop, dense_box, leaked, partial], self.box))
        self.assertIsNone(select_refinement(self.seed, [huge], self.box))

    def test_ninety_percent_retention_boundary_and_preserved_holes(self):
        boundary = self.seed.copy(); boundary[10, 10:15] = False
        self.assertIsNotNone(select_refinement(self.seed, [boundary], self.box))
        boundary[10, 15] = False
        self.assertIsNone(select_refinement(self.seed, [boundary], self.box))
        ring = self.candidate(8, 7, 22, 18); ring[10:14, 14:17] = False
        ring_seed = ring.copy(); ring_seed[7:9] = False
        selected = select_refinement(ring_seed, [ring], self.box)
        self.assertIsNotNone(selected)
        self.assertFalse(selected[11, 15], 'a letter loop must remain transparent')

    def test_foreground_fraction_boundary_rejects_background_block(self):
        seed = np.zeros((20, 20), dtype=bool); seed[3:13, 3:13] = True
        candidate = np.zeros_like(seed); candidate[0:14, 0:20] = True
        candidate[3, 3:13] = False
        self.assertIsNotNone(select_refinement(seed, [candidate], [0, 0, 20, 20]))
        candidate[14, :] = True
        self.assertIsNone(select_refinement(seed, [candidate], [0, 0, 20, 20]))

    def test_invalid_masks_limits_and_more_than_four_candidates_are_not_accepted(self):
        valid = self.candidate(10, 9, 20, 16)
        self.assertIsNone(select_refinement(self.seed, [np.zeros((1, 2), dtype=bool)] * 4 + [valid], self.box))
        self.assertIsNone(select_refinement(self.seed, [valid.astype(float)], self.box))
        with self.assertRaises(ValueError):
            select_refinement(self.seed, [valid], self.box, min_seed_retention=.89)
        with self.assertRaises(ValueError):
            select_refinement(self.seed, [valid], self.box, max_foreground_fraction=.71)
        with self.assertRaises(ValueError):
            select_refinement(self.seed, [valid], [True, 0, 30, 20])


class RefinementLifecycleTest(unittest.TestCase):
    def refiner(self):
        refiner = SamRefiner('/unused')
        refiner.torch = SimpleNamespace(inference_mode=nullcontext)
        refiner.events = []
        refiner.predictor = SimpleNamespace(
            set_image=lambda rgb: refiner.events.append(('image', rgb.shape)),
            reset_image=lambda: refiner.events.append(('reset',)))
        refiner._ensure_model = lambda: refiner.events.append(('ensure',))
        return refiner

    def test_one_embedding_up_to_four_boxes_seed_unchanged_and_no_accepted_mask_falls_back(self):
        refiner = self.refiner()
        seed = np.zeros((30, 50), dtype=bool); seed[10:15, 10:20] = True
        original = seed.copy()
        seen = []
        def predict(box):
            seen.append(box)
            return [np.ones_like(seed)]
        refiner._predict_masks = predict
        output = refiner.refine(np.zeros((30, 50, 3), np.uint8), seed, [[5, 5, 35, 25]] * 4)
        np.testing.assert_array_equal(output, original)
        np.testing.assert_array_equal(seed, original)
        self.assertEqual(len(seen), 4)
        self.assertEqual([event[0] for event in refiner.events], ['ensure', 'image', 'reset'])
        with self.assertRaises(ValueError):
            refiner.refine(np.zeros((30, 50, 3), np.uint8), seed, [[5, 5, 35, 25]] * 5)

    def test_accepted_refinement_replaces_weak_seed_only_inside_proposal(self):
        refiner = self.refiner()
        seed = np.zeros((30, 50), dtype=bool); seed[10:15, 10:20] = True
        seed[28, 45] = True
        candidate = seed.copy(); candidate[10, 10:15] = False; candidate[15, 10:20] = True
        candidate[28, 45] = False
        refiner._predict_masks = lambda box: [candidate]
        output = refiner.refine(np.zeros((30, 50, 3), np.uint8), seed, [[5, 5, 35, 25]])
        self.assertFalse(output[10, 10])
        self.assertTrue(np.all(output[15, 10:20]))
        self.assertTrue(output[28, 45], 'alpha outside proposal must survive')

    def test_glyph_context_uses_its_own_seed_and_adds_flourish_without_erasing_neighbor(self):
        refiner = self.refiner()
        seed = np.zeros((30, 50), dtype=bool)
        seed[10:15, 10:20] = True
        seed[8:20, 25:30] = True  # Another letter inside the prompt's context.
        candidate = np.zeros_like(seed)
        candidate[10:15, 10:20] = True
        candidate[15:18, 8:20] = True  # A newly recovered curved stroke.
        refiner._predict_masks = lambda box: [candidate]
        output = refiner.refine(np.zeros((30, 50, 3), np.uint8), seed,
            [{'box': [5, 5, 35, 25], 'seedBox': [10, 10, 20, 15], 'additive': True}])
        self.assertTrue(output[17, 8])
        self.assertTrue(np.all(output[8:20, 25:30]), 'recovering one glyph must preserve its neighbor')
        self.assertEqual([event[0] for event in refiner.events], ['ensure', 'image', 'reset'])

    def test_glyph_seed_must_stay_inside_its_context(self):
        refiner = self.refiner()
        with self.assertRaises(ValueError):
            refiner.refine(np.zeros((30, 50, 3), np.uint8), np.zeros((30, 50), bool),
                [{'box': [5, 5, 35, 25], 'seedBox': [0, 0, 20, 15], 'additive': True}])
        self.assertEqual(refiner.events, [])

    def test_no_seed_skips_model_and_decoder_failure_clears_embedding(self):
        refiner = self.refiner()
        rgb = np.zeros((30, 50, 3), np.uint8); seed = np.zeros((30, 50), dtype=bool)
        output = refiner.refine(rgb, seed, [[5, 5, 35, 25]])
        self.assertFalse(output.any()); self.assertEqual(refiner.events, [])
        seed[10:15, 10:20] = True
        refiner._predict_masks = lambda box: (_ for _ in ()).throw(RuntimeError('decoder'))
        with self.assertRaises(RuntimeError):
            refiner.refine(rgb, seed, [[5, 5, 35, 25]])
        self.assertEqual(refiner.events[-1], ('reset',))

    def test_mismatched_shape_bad_rgb_and_out_of_bounds_box_fail_before_loading(self):
        refiner = self.refiner()
        for rgb, seed, boxes in (
            (np.zeros((30, 50, 4), np.uint8), np.zeros((30, 50), bool), []),
            (np.zeros((30, 50, 3), float), np.zeros((30, 50), bool), []),
            (np.zeros((30, 50, 3), np.uint8), np.zeros((20, 50), bool), []),
            (np.zeros((30, 50, 3), np.uint8), np.zeros((30, 50), bool), [[0, 0, 51, 30]]),
        ):
            with self.subTest(shape=rgb.shape, boxes=boxes), self.assertRaises(ValueError):
                refiner.refine(rgb, seed, boxes)
        self.assertEqual(refiner.events, [])


if __name__ == '__main__':
    unittest.main()
