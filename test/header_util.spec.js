import {header_t, header_t2buffer, buffer2header_t, block_info_t2buffer, block_info_t, buffer2block_info_t, ntpackage2batch, batch2ntpackage} from "../src/header_util"

let magic_number =
  Buffer.from("1fe2ef7f3ed18847", "hex");

test('header_t and buffer', ()=>{
  let h = new header_t(magic_number, 2, 1, 1);
  let buf = header_t2buffer(h);
  let h1 = buffer2header_t(buf);
  expect(h1.magic_number).toStrictEqual(h.magic_number);
  expect(h1.version_number).toBe(h.version_number);
  expect(h1.block_number).toBe(h.block_number);
  expect(h1.item_number).toBe(h.item_number);
})

test('block_info_t and buffer', ()=>{
  let b = new block_info_t(1, 2, 3, 4);
  let buf = block_info_t2buffer(b);
  let b1 = buffer2block_info_t(buf);
  expect(b1.start_item_index).toBe(b.start_item_index);
  expect(b1.end_item_index).toBe(b.end_item_index);
  expect(b1.start_file_pos).toBe(b.start_file_pos);
  expect(b1.end_file_pos).toBe(b.end_file_pos);
} )
