import {
  header_t,
  block_info_t
} from "./common/header_util.js"

const BlockFile = function(MagicNumber, BlockNumLimit, ItemNumPerBlockLimit) {
  if (!(this instanceof BlockFile)) {
    return new BlockFile(MagicNumber, BlockNumLimit, ItemNumPerBlockLimit);
  }

  let m_header = new header_t(0, 2, 0, 0);
  let m_block_infos = [];
  //let block_start_offset = 32 + 32 * BlockNumLimit;
  let block_start_offset = 0;

  this.append_item = function(buf, header, block_meta_info) {
    m_header = header;
    m_block_infos = block_meta_info;

    m_header.item_number++;
    m_header.magic_number = MagicNumber;
    m_header.data_hash = header.data_hash;

    var bi = new block_info_t(0, 0, 0, 0);
    if (0 === m_block_infos.length) {
      bi.start_item_index = 0;
      bi.end_item_index = 1;
      bi.start_file_pos = block_start_offset;
      bi.end_file_pos = bi.start_file_pos + buf.length + 8;
      m_block_infos.push(bi);
      m_header.block_number++;
    } else {
      bi = m_block_infos[m_block_infos.length - 1];
      if (bi.end_item_index - bi.start_item_index >= ItemNumPerBlockLimit) {
        let new_block = new block_info_t(0, 0, 0, 0);
        new_block.start_item_index = bi.end_item_index;
        new_block.end_item_index = new_block.start_item_index + 1;
        new_block.start_file_pos = bi.end_file_pos;
        new_block.end_file_pos = new_block.start_file_pos + buf.length + 8;
        m_block_infos.push(new_block);
        m_header.block_number++;
      } else {
        bi.end_item_index++;
        bi.end_file_pos = bi.end_file_pos + buf.length + 8;
      }
    }
    return [m_header, m_block_infos];
  };
};

export default BlockFile;
